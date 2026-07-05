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
 *   (c) CMUX_SOCKET_PATH if set, else "unset (auto-discover)";
 *   (d) read-only `.mcp.json` drift detection for stale `cmux` keys or entries
 *       that bypass `~/.golems/bin/cmuxlayer-mcp`.
 *
 * Non-interactivity invariants (§ headline / conformance checks):
 *   - exit 0 when healthy; runs cleanly under `</dev/null` with NONINTERACTIVE=1;
 *   - NO bare `sudo` anywhere (this module shells only to `brew`, best-effort);
 *   - brew is best-effort: "brew not found" is reported, never a hard failure.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

export interface McpConfigDriftEntry {
  path: string;
  serverKey: string;
  reason: string;
}

export interface McpConfigDriftReport {
  scanned: number;
  drifted: McpConfigDriftEntry[];
  note: string;
}

export type RuntimeMode = "dist" | "source" | "launcher" | "unknown";

export interface RuntimeProvenanceReport {
  distEntrypoint: boolean;
  entrypoint: string;
  execPath: string;
  mode: RuntimeMode;
  nodeVersion: string;
  ok: boolean;
  note: string;
}

export interface DetectRuntimeProvenanceOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  nodeVersion?: string;
}

export interface McpReconnectProcedureReport {
  automation: false;
  note: string;
}

/** Lists candidate `.mcp.json` paths; best-effort callers may include missing files. */
export type McpConfigPathLister = () => Promise<string[]> | string[];

/** Reads a `.mcp.json` file; failures are skipped by the drift check. */
export type McpConfigFileReader = (path: string) => Promise<string> | string;

export interface CheckMcpConfigDriftOptions {
  listMcpConfigPaths?: McpConfigPathLister;
  readMcpConfigFile?: McpConfigFileReader;
}

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
  /** Running process provenance: source vs dist path for merged-vs-live checks. */
  runtimeProvenance: RuntimeProvenanceReport;
  /** Manual MCP reconnect probe; documented here so doctor output carries the runbook. */
  mcpReconnectProcedure: McpReconnectProcedureReport;
  /** Read-only `.mcp.json` drift report; does NOT affect health. */
  mcpConfigDrift: McpConfigDriftReport;
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
  /** Injectable `.mcp.json` path lister for read-only drift checks. */
  listMcpConfigPaths?: McpConfigPathLister;
  /** Injectable `.mcp.json` file reader for read-only drift checks. */
  readMcpConfigFile?: McpConfigFileReader;
  /** Injectable runtime provenance probe for tests. */
  runtimeProvenance?: () => RuntimeProvenanceReport;
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

export const realMcpConfigPathLister: McpConfigPathLister = async () => {
  try {
    const entries = await readdir(join(homedir(), "Gits"), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(homedir(), "Gits", entry.name, ".mcp.json"));
  } catch {
    return [];
  }
};

export const realMcpConfigFileReader: McpConfigFileReader = (path) =>
  readFile(path, "utf-8");

function normalizePathForRuntime(value: string): string {
  return value.replaceAll("\\", "/");
}

export function detectRuntimeProvenance(
  opts: DetectRuntimeProvenanceOptions = {},
): RuntimeProvenanceReport {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const entrypoint = argv[1] ?? "";
  const normalizedEntrypoint = normalizePathForRuntime(entrypoint);
  const execPath = opts.execPath ?? process.execPath;
  const nodeVersion = opts.nodeVersion ?? process.version;
  const brewBinEntrypoint =
    normalizedEntrypoint === "cmuxlayer" ||
    /\/(?:opt\/homebrew|usr\/local)\/bin\/cmuxlayer$/.test(
      normalizedEntrypoint,
    ) ||
    /\/Cellar\/cmuxlayer\/[^/]+\/(?:libexec\/)?bin\/cmuxlayer$/.test(
      normalizedEntrypoint,
    );
  const distEntrypoint =
    /\/dist\/index\.js$/.test(normalizedEntrypoint) || brewBinEntrypoint;
  const sourceEntrypoint = /\/src\/index\.ts$/.test(normalizedEntrypoint);
  const launcherEntrypoint =
    normalizedEntrypoint === "cmuxlayer-mcp" ||
    normalizedEntrypoint.endsWith("/.golems/bin/cmuxlayer-mcp");

  let mode: RuntimeMode = "unknown";
  if (distEntrypoint) {
    mode = "dist";
  } else if (launcherEntrypoint) {
    mode = "launcher";
  } else if (sourceEntrypoint || env.CMUXLAYER_DEV === "1") {
    mode = "source";
  }

  const note =
    mode === "dist" && brewBinEntrypoint
      ? "running brew-installed cmuxlayer bin; verify this path/version is the live MCP child after reconnect"
      : mode === "dist"
      ? "running dist/index.js; verify this path/version is the live MCP child after reconnect"
      : mode === "source"
        ? "running live source; useful for development but not the pinned dist runtime"
        : mode === "launcher"
          ? "running launcher path; launcher should exec brew dist unless development env overrides it"
          : "runtime entrypoint is unknown; inspect argv/process manager before trusting live provenance";

  return {
    distEntrypoint,
    entrypoint,
    execPath,
    mode,
    nodeVersion,
    ok: distEntrypoint,
    note,
  };
}

function mcpReconnectProcedure(): McpReconnectProcedureReport {
  return {
    automation: false,
    note: "Manual probe: focus the target surface, run /mcp, choose cmuxlayer, choose Reconnect, verify terminal output, then run cmuxlayer doctor --json to confirm runtime provenance.",
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCmuxlayerMcpLauncher(part: string): boolean {
  const normalized = part.replaceAll("\\", "/");
  return (
    normalized === "cmuxlayer-mcp" ||
    normalized === "~/.golems/bin/cmuxlayer-mcp" ||
    normalized.endsWith("/.golems/bin/cmuxlayer-mcp")
  );
}

function serverReferencesLauncher(server: unknown): boolean {
  if (!isRecord(server)) {
    return false;
  }

  const command = typeof server.command === "string" ? server.command : "";
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : [];

  return [command, ...args].some(isCmuxlayerMcpLauncher);
}

function driftReason(serverKey: string, server: unknown): string | null {
  const reasons: string[] = [];

  if (serverKey === "cmux") {
    reasons.push("stale server key cmux (use cmuxlayer)");
  }

  if (!serverReferencesLauncher(server)) {
    reasons.push("does not reference launcher cmuxlayer-mcp");
  }

  return reasons.length > 0 ? reasons.join("; ") : null;
}

export async function checkMcpConfigDrift(
  opts: CheckMcpConfigDriftOptions = {},
): Promise<McpConfigDriftReport> {
  const listMcpConfigPaths =
    opts.listMcpConfigPaths ?? realMcpConfigPathLister;
  const readMcpConfigFile =
    opts.readMcpConfigFile ?? realMcpConfigFileReader;

  let paths: string[];
  try {
    paths = await listMcpConfigPaths();
  } catch {
    paths = [];
  }

  const drifted: McpConfigDriftEntry[] = [];
  let scanned = 0;

  for (const path of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readMcpConfigFile(path));
    } catch {
      continue;
    }

    scanned += 1;

    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      continue;
    }

    for (const [serverKey, server] of Object.entries(parsed.mcpServers)) {
      if (serverKey !== "cmux" && serverKey !== "cmuxlayer") {
        continue;
      }

      const reason = driftReason(serverKey, server);
      if (reason) {
        drifted.push({ path, serverKey, reason });
      }
    }
  }

  return {
    scanned,
    drifted,
    note: "scanned ~/Gits/*/.mcp.json for cmux/cmuxlayer entries expected to reference launcher cmuxlayer-mcp; read-only, skipped missing/unreadable/invalid JSON",
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
  const runtimeProvenance = (
    opts.runtimeProvenance ?? (() => detectRuntimeProvenance({ env }))
  )();
  const mcpConfigDrift = await checkMcpConfigDrift({
    listMcpConfigPaths: opts.listMcpConfigPaths,
    readMcpConfigFile: opts.readMcpConfigFile,
  });

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
    runtimeProvenance,
    mcpReconnectProcedure: mcpReconnectProcedure(),
    mcpConfigDrift,
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

  lines.push(
    `│ ${mark(report.runtimeProvenance.ok)} runtime provenance: ${report.runtimeProvenance.mode} ${report.runtimeProvenance.entrypoint || "(unknown entrypoint)"}`,
  );
  lines.push(`│      ${report.runtimeProvenance.note}`);

  lines.push(`│ — MCP reconnect probe: ${report.mcpReconnectProcedure.note}`);

  if (report.mcpConfigDrift.drifted.length === 0) {
    lines.push(
      `│ ✔ .mcp.json drift: no mcp config drift (${report.mcpConfigDrift.scanned} scanned)`,
    );
  } else {
    lines.push(
      `│ ✗ .mcp.json drift: ${report.mcpConfigDrift.drifted.length} drifted (${report.mcpConfigDrift.scanned} scanned)`,
    );
    for (const entry of report.mcpConfigDrift.drifted) {
      lines.push(
        `│      ${entry.path} [${entry.serverKey}]: ${entry.reason}`,
      );
    }
  }

  lines.push("└─");
  return lines.join("\n");
}

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
