import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");
const memoryWatchdogScript =
  process.env.CMUX_MEMORY_WATCHDOG_SCRIPT_PATH ??
  join(repoRoot, "launchd/cmux-memory-watchdog/bin/cmux-memory-watchdog.sh");
const ramSamplerScript =
  process.env.CMUX_RAM_SAMPLER_SCRIPT_PATH ??
  join(repoRoot, "launchd/cmux-ram-sampler/bin/cmux-ram-sampler.sh");

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  mkdirSync(join(root, "fixtures"), { recursive: true });
  return root;
}

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function readIfExists(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function fileMissingOrEmpty(path: string) {
  return !existsSync(path) || statSync(path).size === 0;
}

function samplerKillTrap(logDir: string) {
  return `
export CMUX_TEST_KILL_TRAP_LOG=${JSON.stringify(join(logDir, "kill.log"))}
kill() {
  printf 'kill %s\\n' "$*" >>"$CMUX_TEST_KILL_TRAP_LOG"
  return 0
}
pkill() {
  printf 'pkill %s\\n' "$*" >>"$CMUX_TEST_KILL_TRAP_LOG"
  return 0
}
killall() {
  printf 'killall %s\\n' "$*" >>"$CMUX_TEST_KILL_TRAP_LOG"
  return 0
}
osascript() {
  printf 'osascript %s\\n' "$*" >>"$CMUX_TEST_KILL_TRAP_LOG"
  return 0
}
launchctl() {
  printf 'launchctl %s\\n' "$*" >>"$CMUX_TEST_KILL_TRAP_LOG"
  return 0
}
export -f kill pkill killall osascript launchctl
`;
}

function runBash(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function seedMemoryWatchdogCommands(root: string) {
  const logDir = join(root, "logs");
  writeExecutable(
    join(root, "bin/ps"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '4242 /Applications/cmux.app/Contents/MacOS/cmux\\n'
printf '9001 /Applications/Browser.app/Contents/MacOS/browser\\n'
`,
  );
  writeExecutable(
    join(root, "bin/pgrep"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-x" && "\${2:-}" == "cmux" ]]; then
  printf '4242\\n'
  exit 0
fi
if [[ "\${1:-}" == "-lf" && "\${2:-}" == "cmux" ]]; then
  printf '4242 cmux\\n'
  exit 0
fi
exit 1
`,
  );
  writeExecutable(
    join(root, "bin/nc"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
  );
  writeExecutable(
    join(root, "bin/curl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'args:%s\\n' "$*" >>"${logDir}/curl.log"
while IFS= read -r line; do
  printf 'stdin:%s\\n' "$line" >>"${logDir}/curl.log"
done
`,
  );
  writeExecutable(
    join(root, "bin/kill"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"${logDir}/kill.log"
`,
  );
  writeFileSync(join(root, "fixtures/footprint.fixture"), "4242 phys_footprint: 6 GB (peak 8 GB)\n");
  writeFileSync(
    join(root, "fixtures/vmstat.fixture"),
    "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor: 0.\n",
  );
}

function seedSamplerCommands(root: string) {
  const logDir = join(root, "logs");
  writeExecutable(
    join(root, "bin/pgrep"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-f" && "\${2:-}" == "/Applications/cmux.app/Contents/MacOS/cmux" ]]; then
  printf '4242\\n'
  exit 0
fi
exit 1
`,
  );
  writeExecutable(
    join(root, "bin/ps"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '9999 900000 /Applications/Browser.app/Contents/MacOS/browser --tabs\\n'
printf '4242 200000 /Applications/cmux.app/Contents/MacOS/cmux\\n'
`,
  );
  writeExecutable(
    join(root, "bin/nc"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
  );
  writeExecutable(
    join(root, "bin/curl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'args:%s\\n' "$*" >>"${logDir}/curl.log"
while IFS= read -r line; do
  printf 'stdin:%s\\n' "$line" >>"${logDir}/curl.log"
done
`,
  );
  writeFileSync(join(root, "fixtures/footprint.fixture"), "4242 phys_footprint: 1024 MB (peak 2048 MB)\n");
  writeFileSync(join(root, "fixtures/memsize.fixture"), "1048576\n");
}

describe("cmux RAM watchdog warn-only regression", () => {
  it("turns a watchdog memory breach into notification/snapshot work without SIGKILLing cmux", () => {
    const root = makeRoot("cmux-watchdog-vitest-");
    const logDir = join(root, "logs");
    seedMemoryWatchdogCommands(root);

    const result = runBash(
      `source "${memoryWatchdogScript}"
run_once`,
      {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        CMUX_MEM_WATCHDOG_SOURCE_ONLY: "1",
        CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB: "5",
        CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB: "12",
        CMUX_MEM_WATCHDOG_LOG_DIR: logDir,
        CMUX_MEM_WATCHDOG_NOTIFY_URL: "http://localhost:3847/notify",
        CMUX_MEM_WATCHDOG_BRAINBAR_SOCK: join(root, "missing-brainbar.sock"),
        CMUX_MEM_WATCHDOG_KILL_BIN: join(root, "bin/kill"),
        CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS: "0",
        CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE: join(root, "fixtures/footprint.fixture"),
        CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE: join(root, "fixtures/vmstat.fixture"),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fileMissingOrEmpty(join(logDir, "kill.log"))).toBe(true);
    expect(readIfExists(join(logDir, "kill.log"))).not.toMatch(/-(TERM|KILL)\s+4242/);
    expect(readIfExists(join(logDir, "curl.log"))).toContain("http://localhost:3847/notify");
    expect(readIfExists(join(logDir, "curl.log"))).toContain("Warning only; cmux was not terminated.");
    expect(result.stderr).toContain("left running after memory breach (warn-only default)");
  });

  it("pins free_ram_pct calibration at the 12 percent routine-high boundary without alerting or killing", () => {
    const root = makeRoot("cmux-sampler-vitest-");
    const logDir = join(root, "logs");
    seedSamplerCommands(root);
    writeFileSync(
      join(root, "fixtures/vmstat.fixture"),
      [
        "Mach Virtual Memory Statistics:",
        "Pages free: 4.",
        "Pages inactive: 4.",
        "Pages occupied by compressor: 0.",
        "",
      ].join("\n"),
    );

    const result = runBash(
      `${samplerKillTrap(logDir)}
source "${ramSamplerScript}"
run_once`,
      {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        CMUX_RAM_SAMPLER_SOURCE_ONLY: "1",
        CMUX_RAM_SAMPLER_LOG_DIR: logDir,
        CMUX_RAM_SAMPLER_SAMPLE_FILE: join(logDir, "samples.jsonl"),
        CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE: join(logDir, "routed-alerts.jsonl"),
        CMUX_RAM_SAMPLER_NEARCRASH_STATE_DIR: join(logDir, "nearcrash-state"),
        CMUX_RAM_SAMPLER_NOTIFY_URL: "http://localhost:3847/notify",
        CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE: join(root, "fixtures/memsize.fixture"),
        CMUX_RAM_SAMPLER_VMSTAT_FIXTURE: join(root, "fixtures/vmstat.fixture"),
        CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE: join(root, "fixtures/footprint.fixture"),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readIfExists(join(logDir, "samples.jsonl"))).toContain('"free_ram_pct":12');
    expect(readIfExists(join(logDir, "curl.log"))).toBe("");
    expect(readIfExists(join(logDir, "routed-alerts.jsonl"))).toBe("");
    expect(fileMissingOrEmpty(join(logDir, "kill.log"))).toBe(true);
  });

  it("routes a near-crash free_ram_pct breach with offenders and still never invokes kill", () => {
    const root = makeRoot("cmux-nearcrash-vitest-");
    const logDir = join(root, "logs");
    seedSamplerCommands(root);
    writeFileSync(
      join(root, "fixtures/vmstat.fixture"),
      [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free: 2.",
        "Pages inactive: 0.",
        "Pages occupied by compressor: 0.",
        "",
      ].join("\n"),
    );

    const result = runBash(
      `${samplerKillTrap(logDir)}
source "${ramSamplerScript}"
run_once`,
      {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        CMUX_RAM_SAMPLER_SOURCE_ONLY: "1",
        CMUX_RAM_SAMPLER_LOG_DIR: logDir,
        CMUX_RAM_SAMPLER_SAMPLE_FILE: join(logDir, "samples.jsonl"),
        CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE: join(logDir, "routed-alerts.jsonl"),
        CMUX_RAM_SAMPLER_NEARCRASH_STATE_DIR: join(logDir, "nearcrash-state"),
        CMUX_RAM_SAMPLER_NOTIFY_URL: "http://localhost:3847/notify",
        CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE: join(root, "fixtures/memsize.fixture"),
        CMUX_RAM_SAMPLER_VMSTAT_FIXTURE: join(root, "fixtures/vmstat.fixture"),
        CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE: join(root, "fixtures/footprint.fixture"),
      },
    );

    const alert = readIfExists(join(logDir, "routed-alerts.jsonl"));
    expect(result.status, result.stderr).toBe(0);
    expect(readIfExists(join(logDir, "samples.jsonl"))).toContain('"free_ram_pct":3');
    expect(alert).toContain('"type":"near_crash"');
    expect(alert).toContain('"reason":"near-crash free_ram_pct=3%"');
    expect(alert).toContain("Browser.app");
    expect(alert).toContain("cmux.app");
    expect(fileMissingOrEmpty(join(logDir, "kill.log"))).toBe(true);
    expect(readIfExists(join(logDir, "kill.log"))).not.toMatch(/-(TERM|KILL)\s+4242/);
  });

  it("records injected shell kill builtin attempts in the sampler no-kill guard", () => {
    const root = makeRoot("cmux-sampler-killtrap-vitest-");
    const logDir = join(root, "logs");
    seedSamplerCommands(root);

    const result = runBash(
      `${samplerKillTrap(logDir)}
source "${ramSamplerScript}"
kill -9 4242 || true`,
      {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        CMUX_RAM_SAMPLER_SOURCE_ONLY: "1",
        CMUX_RAM_SAMPLER_LOG_DIR: logDir,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readIfExists(join(logDir, "kill.log"))).toContain("-9 4242");
  });
});
