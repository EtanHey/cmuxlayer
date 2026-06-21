/**
 * cmuxlayer doctor — the STDIO reference impl for the Robust Brew Layer standard
 * (~/Gits/orchestrator/standards/robust-brew-layer.md §0, §1, §3, §6).
 *
 * cmuxlayer is a stdio MCP server with NO cask and NO daemon, so two of the
 * standard's conformance classes are structurally not-applicable:
 *   - §1 (account-rename self-heal): N/A — there is no Caskroom artifact to
 *     go stale. `doctor` MUST say so explicitly, not silently no-op.
 *   - §5 (daemon integrity): N/A — there is no socket/launchd daemon.
 *
 * The checks `doctor` actually runs:
 *   (a) version resolves/prints;
 *   (b) §3 tap — whether `brew tap` lists etanhey/layers and the formula
 *       resolves (`brew info etanhey/layers/cmuxlayer`). Tap CASKS need
 *       `brew trust etanhey/layers`; cmuxlayer is a formula, not gated.
 *   (c) CMUX_SOCKET_PATH if set, else "unset (auto-discover)".
 *
 * Non-interactivity invariants (§ headline / conformance checks):
 *   - exit 0 when healthy; runs cleanly under `</dev/null` with NONINTERACTIVE=1;
 *   - NO bare `sudo` anywhere (this module shells only to `brew`, best-effort);
 *   - brew is best-effort: "brew not found" is reported, never a hard failure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TAP_NAME = "etanhey/layers";
export const FORMULA_NAME = "etanhey/layers/cmuxlayer";
export const SLEEP_GUARD_LABEL = "com.golems.cmux-caffeinate";
export const SLEEP_GUARD_README = "launchd/cmux-caffeinate/README.md";

/** Result of a single best-effort `brew <args>` invocation. */
export interface BrewResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** true when `brew` itself is not on PATH (ENOENT) — best-effort, not a failure. */
  notFound?: boolean;
}

/** Runs `brew <args>`; never throws — failures are reported in the result. */
export type BrewRunner = (args: string[]) => Promise<BrewResult>;

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

/** Runs `pmset -g assertions`; never throws — failures are reported in the result. */
export type PmsetRunner = () => Promise<CommandResult>;

/** Runs `launchctl print gui/<uid>/com.golems.cmux-caffeinate`; never throws. */
export type LaunchctlRunner = () => Promise<CommandResult>;

export interface DoctorReport {
  /** Overall health. brew/tap gaps do NOT make the doctor unhealthy. */
  healthy: boolean;
  version: { ok: boolean; value: string };
  /** §1 account-rename self-heal — not-applicable for a stdio/no-cask layer. */
  caskSelfHeal: { applicable: false; note: string };
  /** §5 daemon integrity — not-applicable for a stdio/no-daemon layer. */
  daemon: { applicable: false; note: string };
  /** §3 tap — best-effort report; brew may be absent. */
  tap: {
    brewAvailable: boolean;
    tapPresent: boolean;
    formulaResolves: boolean;
    note: string;
  };
  /** CMUX_SOCKET_PATH pin (auto-discover when unset). */
  socketPath: { set: boolean; value: string | null; note: string };
  /** Durable sleep-survival guard: pmset assertion plus launchd KeepAlive job. */
  sleepGuard: {
    systemSleepPrevented: boolean;
    keepAliveLoaded: boolean;
    durable: boolean;
    note: string;
  };
}

export interface RunDoctorOptions {
  /** The resolved version string (e.g. from package.json); "unknown" => not-ok. */
  version: string;
  /** Environment to inspect; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable brew runner; defaults to the real `brew` via execFile. */
  brew?: BrewRunner;
  /** Injectable pmset runner; defaults to the real `pmset -g assertions`. */
  pmset?: PmsetRunner;
  /** Injectable launchctl runner; defaults to the real launchd service probe. */
  launchctl?: LaunchctlRunner;
}

/**
 * The real `brew` runner. Best-effort and non-interactive:
 *   - sets NONINTERACTIVE=1 and HOMEBREW_NO_AUTO_UPDATE=1 so brew never prompts;
 *   - never invokes sudo;
 *   - on ENOENT (brew not installed) returns `notFound: true` rather than throwing.
 */
export const realBrewRunner: BrewRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync("brew", args, {
      env: {
        ...process.env,
        NONINTERACTIVE: "1",
        HOMEBREW_NO_AUTO_UPDATE: "1",
        HOMEBREW_NO_ANALYTICS: "1",
      },
      timeout: 20_000,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT") {
      return { ok: false, stdout: "", stderr: "", notFound: true };
    }
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr:
        e.stderr ?? (error instanceof Error ? error.message : String(error)),
    };
  }
};

export const realPmsetRunner: PmsetRunner = async () => {
  try {
    const { stdout, stderr } = await execFileAsync("pmset", ["-g", "assertions"], {
      timeout: 10_000,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT") {
      return { ok: false, stdout: "", stderr: "", notFound: true };
    }
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr:
        e.stderr ?? (error instanceof Error ? error.message : String(error)),
    };
  }
};

function currentUid(): string {
  if (typeof process.getuid === "function") {
    return String(process.getuid());
  }
  return process.env.UID ?? "501";
}

export const realLaunchctlRunner: LaunchctlRunner = async () => {
  try {
    const { stdout, stderr } = await execFileAsync(
      "launchctl",
      ["print", `gui/${currentUid()}/${SLEEP_GUARD_LABEL}`],
      { timeout: 10_000 },
    );
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT") {
      return { ok: false, stdout: "", stderr: "", notFound: true };
    }
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr:
        e.stderr ?? (error instanceof Error ? error.message : String(error)),
    };
  }
};

async function checkTap(brew: BrewRunner): Promise<DoctorReport["tap"]> {
  const tapNote = `tap CASKS need \`brew trust ${TAP_NAME}\`; cmuxlayer is a formula, not gated`;

  const tapList = await brew(["tap"]);
  if (tapList.notFound) {
    return {
      brewAvailable: false,
      tapPresent: false,
      formulaResolves: false,
      note: "brew not found (skipped tap check)",
    };
  }

  const tapPresent = tapList.ok
    ? tapList.stdout
        .split("\n")
        .map((line) => line.trim())
        .includes(TAP_NAME)
    : false;

  // `brew info etanhey/layers/cmuxlayer` — does the formula resolve?
  const info = await brew(["info", FORMULA_NAME]);
  const formulaResolves = info.notFound ? false : info.ok;

  return {
    brewAvailable: true,
    tapPresent,
    formulaResolves,
    note: tapNote,
  };
}

export function parseSystemSleepPrevented(
  pmsetAssertionsStdout: string,
): boolean {
  return pmsetAssertionsStdout.split("\n").some((line) => {
    const match = line.match(/^\s*PreventUserIdleSystemSleep\s+([01])\s*$/);
    return match?.[1] === "1";
  });
}

async function checkSleepGuard(
  pmset: PmsetRunner,
  launchctl: LaunchctlRunner,
): Promise<DoctorReport["sleepGuard"]> {
  const pmsetResult = await pmset();
  const launchctlResult = await launchctl();

  const systemSleepPrevented = pmsetResult.ok
    ? parseSystemSleepPrevented(pmsetResult.stdout)
    : false;
  const keepAliveLoaded = launchctlResult.ok;
  const durable = systemSleepPrevented && keepAliveLoaded;

  return {
    systemSleepPrevented,
    keepAliveLoaded,
    durable,
    note: durable
      ? "durable: pmset assertion active and launchd KeepAlive guard loaded"
      : `not durable; install ${SLEEP_GUARD_README}`,
  };
}

export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const brew = opts.brew ?? realBrewRunner;
  const pmset = opts.pmset ?? realPmsetRunner;
  const launchctl = opts.launchctl ?? realLaunchctlRunner;

  const versionOk = opts.version !== "unknown" && opts.version.length > 0;

  const socketRaw = env.CMUX_SOCKET_PATH;
  const socketSet = typeof socketRaw === "string" && socketRaw.length > 0;

  const tap = await checkTap(brew);
  const sleepGuard = await checkSleepGuard(pmset, launchctl);

  // Health: only the version must resolve. Brew/tap gaps are reported but, per
  // the standard's "brew best-effort" rule, must NOT make the doctor unhealthy
  // (so it exits 0 on machines without brew or without the tap added yet).
  const healthy = versionOk;

  return {
    healthy,
    version: { ok: versionOk, value: opts.version },
    caskSelfHeal: {
      applicable: false,
      note: "not-applicable: stdio MCP, no cask (§1 account-rename self-heal)",
    },
    daemon: {
      applicable: false,
      note: "not-applicable: stdio MCP, no daemon (§5 daemon integrity)",
    },
    tap,
    socketPath: socketSet
      ? { set: true, value: socketRaw, note: "pinned via CMUX_SOCKET_PATH" }
      : { set: false, value: null, note: "unset (auto-discover)" },
    sleepGuard,
  };
}

function mark(ok: boolean): string {
  return ok ? "✔" : "✗"; // ✔ / ✗
}

export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    `┌─ cmuxlayer doctor ─ ${report.healthy ? "healthy" : "PROBLEMS"}`,
  );

  // (a) version
  lines.push(`│ ${mark(report.version.ok)} version: ${report.version.value}`);

  // §1 — not-applicable, stated explicitly (no silent no-op)
  lines.push(`│ — §1 ${report.caskSelfHeal.note}`);

  // §5 — not-applicable, stated explicitly
  lines.push(`│ — §5 ${report.daemon.note}`);

  // (b) §3 tap
  if (!report.tap.brewAvailable) {
    lines.push(`│ — §3 tap: ${report.tap.note}`);
  } else {
    lines.push(
      `│ ${mark(report.tap.tapPresent)} §3 tap ${TAP_NAME}: ${
        report.tap.tapPresent
          ? "present"
          : "absent (run `brew tap " + TAP_NAME + "`)"
      }`,
    );
    lines.push(
      `│ ${mark(report.tap.formulaResolves)}    formula ${FORMULA_NAME}: ${
        report.tap.formulaResolves ? "resolves" : "does not resolve"
      }`,
    );
    lines.push(`│      ${report.tap.note}`);
  }

  // (c) CMUX_SOCKET_PATH
  lines.push(
    `│ — CMUX_SOCKET_PATH: ${
      report.socketPath.set ? report.socketPath.value : report.socketPath.note
    }`,
  );

  lines.push(
    `│ ${mark(report.sleepGuard.durable)} sleep guard: ${report.sleepGuard.note}`,
  );

  lines.push("└─");
  return lines.join("\n");
}

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
