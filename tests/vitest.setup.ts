import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import { setResumeArtifactResolver } from "../src/resume-verification.js";

// The release script bumps package.json before its pre-push Vitest rerun.
// Keep unit tests from comparing that temporary version with the host brew tree.
process.env.CMUXLAYER_DEV = "1";

// AIDEV-NOTE: the seat registry (~/.golems/config.yaml) names the seats THIS
// operator runs. A test that reads it asserts against the host's fleet, so it
// passes on one Mac and fails everywhere else — which is exactly how a
// `brainClaude` assertion stayed green locally while CI was red for six days.
// Pin it at a path that cannot exist: tests state their own registry or get none.
process.env.CMUXLAYER_SEAT_REGISTRY_PATH = join(
  __dirname,
  "fixtures",
  "no-seat-registry-on-this-machine.yaml",
);

// AIDEV-NOTE: same rule for the fleet config (~/.config/cmuxlayer/fleet.json):
// a test must never inherit the host fleet's coordination dir, notify URL, or
// doctor checks. Pin an empty config: generic defaults, legacy guard quiet (and
// no worktreeBootstrap, so a test spawn never runs the host's bootstrap, #807).
process.env.CMUXLAYER_FLEET_CONFIG = join(
  __dirname,
  "fixtures",
  "fleet",
  "generic-fleet.json",
);

// AIDEV-NOTE: 63 test files build fixtures at a FIXED name under os.tmpdir()
// (`cmux-agents-test-engine`, `cmux-agents-test-registry`, …) and rmSync that
// path in afterEach. Two suite runs on one machine — two worktrees, or a fleet
// worker testing beside the maintainer — then share those directories and tear
// each other's down mid-test: ENOTEMPTY, plus assertions that quietly read
// another run's state. Measured on one file, run twice at once: 91 and 103
// failures without this, 0 and 0 with it. One temp root per RUN makes every one
// of those fixed names unique per run without touching 63 files.
//
// The root goes under /tmp, not under macOS's `/var/folders/…/T` default: unix
// socket paths cap at ~104 bytes and several suites bind sockets inside a temp
// dir, so a deeper root breaks them. /tmp/cmuxlayer-vitest-<pid> is HALF the
// length of the macOS default — this buys socket headroom rather than spending it.
// tests/global-setup.ts creates this root and removes it when the run ends.
const root =
  process.env.CMUXLAYER_TEST_TMP_ROOT?.trim() ||
  join("/tmp", `cmuxlayer-vitest-${process.ppid}`);
mkdirSync(root, { recursive: true });
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;
// AIDEV-NOTE (#834): HOME is sandboxed too. Every home-derived default
// (the generic fleet coordinationDir ~/.local/state/cmuxlayer, the daemon's
// ~/.local/state/cmux-agents, a golems fleet's ~/.golems-zikaron) resolves
// through os.homedir(), which reads HOME. On a fleet Mac those are LIVE
// directories the running daemon uses; a unit test once created and updated
// ~/.golems-zikaron/.outbox-drained.json. Pointing HOME into the run's temp
// root makes a stray default write land in the sandbox, which global-setup
// removes with the root. tests/hermetic-home.test.ts pins it.
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
// Keep CLI subprocesses and direct engine construction on the same run root.
process.env.CMUXLAYER_INBOX_BASE_DIR = join(root, "agents");
process.env.CMUX_AGENTS_DIR = process.env.CMUXLAYER_INBOX_BASE_DIR;
process.env.CMUXLAYER_STATE_DIR = join(root, "state");

// A suite must never signal another seat. Signal 0 is an observation. For a
// mutating signal, require a live child of this worker or a detached inbox
// tailer whose command/pidfile is rooted in this run's sandbox. Log denials
// with the test name before throwing so a caught error remains visible.
const nativeKill = process.kill.bind(process);
const signalLog = join(root, "foreign-signals.jsonl");
const ps = (pid: number): { parent: number; group: number; command: string } | null => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "pgid=", "-o", "command="], {
    encoding: "utf8", timeout: 1000,
  });
  if (result.status !== 0) return null;
  const match = /^\s*(\d+)\s+(\d+)\s+([^\n]*)/.exec(result.stdout);
  return match ? { parent: Number(match[1]), group: Number(match[2]), command: match[3]! } : null;
};
const pidfileMatches = (pid: number): boolean => {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile() && entry.name === "inbox-tail.pid") {
        try {
          if (Number(readFileSync(path, "utf8").split(" ")[0]) === pid) return true;
        } catch { /* a test may remove its fixture while we inspect it */ }
      }
    }
  }
  return false;
};
process.kill = ((pid: number, signal?: NodeJS.Signals | number): boolean => {
  if (signal === 0) return nativeKill(pid, signal);
  const target = Math.abs(pid);
  const observed = target > 1 ? ps(target) : null;
  // A cleanup often reaches a child that already exited. Preserve ESRCH
  // without risking a signal if that PID appears between inspection and kill.
  if (target > 1 && observed === null) {
    const error = new Error(`kill ESRCH: ${pid}`) as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  }
  let owned = false;
  let current = observed;
  const seen = new Set<number>();
  while (current && current.parent > 1 && !seen.has(current.parent)) {
    if (current.parent === process.pid) { owned = true; break; }
    seen.add(current.parent);
    current = ps(current.parent);
  }
  if (pid < 0 && observed?.group !== target) owned = false;
  if (pid > 0 && !owned && observed?.command.startsWith(`tail -n0 -F ${root}/`)) owned = true;
  if (!owned && observed?.command.startsWith("cmuxlayer-inbox-tail ")) {
    owned = pidfileMatches(pid);
  }
  // This live restart fixture deliberately detaches a real daemon. Its path
  // embeds the current Vitest worker PID, so it cannot match a fleet daemon.
  if (pid > 0 && !owned && observed?.command.includes(`/cmuxlayer-live-restart-${process.pid}-`)) {
    owned = true;
  }
  if (!owned) {
    const test = expect.getState().currentTestName ?? "<setup or teardown>";
    const attempt = { test, pid, signal: signal ?? "SIGTERM", command: observed?.command ?? null,
      stack: new Error().stack };
    appendFileSync(signalLog, `${JSON.stringify(attempt)}\n`);
    console.error(`FOREIGN_PID_SIGNAL ${JSON.stringify(attempt)}`);
    throw new Error(`FOREIGN_PID_SIGNAL test=${test} pid=${pid} signal=${signal ?? "SIGTERM"}`);
  }
  return nativeKill(pid, signal);
}) as typeof process.kill;
// #482: `resumable` is now an observation of the harness session store. The
// suite must never read the developer's real ~/.claude to decide it, so the
// default here is the honest "I did not look" answer — which is exactly the
// pre-#482 behaviour. Tests that exercise verification install their own
// resolver (see tests/resume-verification.test.ts).
setResumeArtifactResolver(() => "unverifiable");
