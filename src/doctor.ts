/**
 * cmuxlayer doctor — the STDIO reference impl for the Robust Brew Layer standard
 * (~/Gits/orchestrator/standards/robust-brew-layer.md §0, §1, §3, §6).
 *
 * cmuxlayer is a stdio MCP server with no cask and an on-demand shared daemon,
 * so one conformance class is structurally not-applicable:
 *   - §1 (account-rename self-heal): N/A — there is no Caskroom artifact to
 *     go stale. `doctor` MUST say so explicitly, not silently no-op.
 *   - §5 (daemon integrity): probe the on-demand daemon when it is listening.
 *
 * The checks `doctor` actually runs:
 *   (a) version resolves/prints;
 *   (b) §3 tap — whether `brew tap` lists etanhey/layers and the formula
 *       resolves (`brew info etanhey/layers/cmuxlayer`). Tap CASKS need
 *       `brew trust etanhey/layers`; cmuxlayer is a formula, not gated.
 *   (c) CMUX_SOCKET_PATH if set, else "unset (auto-discover)";
 *   (d) read-only `.mcp.json` drift detection for stale `cmux` keys or entries
 *       that bypass `~/.golems/bin/cmuxlayer-mcp`, plus existence, symlink-target,
 *       and executable-bit checks for every referenced launcher.
 *
 * Non-interactivity invariants (§ headline / conformance checks):
 *   - exit 0 when healthy; runs cleanly under `</dev/null` with NONINTERACTIVE=1;
 *   - NO bare `sudo` anywhere (this module shells only to `brew`, best-effort);
 *   - brew is best-effort: "brew not found" is reported, never a hard failure.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import net from "node:net";
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultDaemonSocketPath } from "./daemon-socket-path.js";
import {
  probeSocketHealth,
  type SocketProbeResult,
} from "./cmux-socket-probe.js";
import {
  detectStaleBuild,
  type DetectStaleBuildDeps,
  type StaleBuildResult,
} from "./version.js";

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
  launcherOk: boolean;
  launchers: McpLauncherProbeReport[];
  note: string;
}

export interface McpLauncherProbeReport {
  path: string;
  resolvedPath: string | null;
  ok: boolean;
  note: string;
}

export type McpLauncherProbe = (
  path: string,
) => Promise<McpLauncherProbeReport> | McpLauncherProbeReport;

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
  probeLauncher?: McpLauncherProbe;
}

export interface DoctorReport {
  /** Overall health. brew/tap gaps do NOT make the doctor unhealthy. */
  healthy: boolean;
  version: { ok: boolean; value: string };
  /** §1 account-rename self-heal — not-applicable for a stdio/no-cask layer. */
  caskSelfHeal: { applicable: false; note: string };
  /** §5 daemon integrity — a missing daemon is healthy because it starts on demand. */
  daemon: {
    applicable: true;
    ok: boolean;
    listening: boolean;
    socketPath: string;
    note: string;
    runningVersion?: string;
    installedVersion?: string;
    transportDegraded?: boolean;
    currentSocketPath?: string | null;
    runningScriptPath?: string;
  };
  /** Additive §5 visibility into PTY write-liveness and monitor reconciliation. */
  selfHeal: DoctorSelfHealReport;
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

export interface DoctorSelfHealReport {
  available: boolean;
  ok: boolean;
  panePtyDead: {
    count: number;
    surfaces: Array<{
      surfaceId: string;
      sinceAt?: string;
      lastAttemptAt: string;
    }>;
    truncated: boolean;
  };
  monitorRegistry: {
    available: boolean;
    error?: string;
    total: number;
    rearming: number;
    collapsed: number;
    collapsedMonitors: Array<{ monitorId: string; reason: string }>;
    truncated: boolean;
  };
  note: string;
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
  /** Injectable installed-build detector for daemon version comparisons. */
  detectStaleBuild?: (
    deps?: DetectStaleBuildDeps,
  ) => StaleBuildResult | null;
  /** Injectable cmux socket health probe for degraded-daemon verification. */
  probeCmuxSocket?: (
    socketPath: string,
  ) => Promise<SocketProbeResult>;
  /** Bound for daemon connect/initialize/control_health (default 1500ms). */
  daemonProbeTimeoutMs?: number;
  /** Injectable path existence check for daemon provenance tests. */
  pathExists?: (path: string) => boolean;
}

type DaemonMcpProbeResult =
  | { kind: "not-listening" }
  | {
      kind: "responding";
      version: string;
      transportDegraded: boolean;
      currentSocketPath: string | null;
      scriptPath: string | null;
      selfHeal: DoctorSelfHealReport;
    }
  | { kind: "error"; error: string };

function unavailableSelfHeal(note: string): DoctorSelfHealReport {
  return {
    available: false,
    ok: true,
    panePtyDead: { count: 0, surfaces: [], truncated: false },
    monitorRegistry: {
      available: false,
      error: note,
      total: 0,
      rearming: 0,
      collapsed: 0,
      collapsedMonitors: [],
      truncated: false,
    },
    note,
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

function parseDoctorSelfHeal(value: unknown): DoctorSelfHealReport {
  if (!isRecord(value)) {
    return unavailableSelfHeal("self-heal state unavailable from control_health");
  }
  const pane = isRecord(value.pane_pty_dead) ? value.pane_pty_dead : null;
  const registry = isRecord(value.monitor_registry)
    ? value.monitor_registry
    : null;
  if (!pane || !registry) {
    return unavailableSelfHeal("self-heal state unavailable from control_health");
  }

  const paneCount = nonNegativeInteger(pane.count);
  const registryAvailable = registry.available;
  const total = nonNegativeInteger(registry.total);
  const rearming = nonNegativeInteger(registry.rearming);
  const collapsed = nonNegativeInteger(registry.collapsed);
  if (
    paneCount === null ||
    typeof registryAvailable !== "boolean" ||
    total === null ||
    rearming === null ||
    collapsed === null ||
    rearming > total ||
    collapsed > total ||
    rearming + collapsed > total
  ) {
    return unavailableSelfHeal("self-heal state malformed in control_health");
  }

  const rawSurfaces = Array.isArray(pane.surfaces) ? pane.surfaces : [];
  const surfaces = rawSurfaces
    .slice(0, 100)
    .flatMap((surface) => {
      if (!isRecord(surface)) return [];
      if (
        typeof surface.surface_id !== "string" ||
        typeof surface.last_attempt_at !== "string" ||
        (surface.since_at !== undefined &&
          typeof surface.since_at !== "string")
      ) {
        return [];
      }
      return [
        {
          surfaceId: surface.surface_id,
          ...(typeof surface.since_at === "string"
            ? { sinceAt: surface.since_at }
            : {}),
          lastAttemptAt: surface.last_attempt_at,
        },
      ];
    });
  const rawCollapsedMonitors = Array.isArray(registry.collapsed_monitors)
    ? registry.collapsed_monitors
    : [];
  const collapsedMonitors = rawCollapsedMonitors
    .slice(0, 100)
    .flatMap((monitor) => {
      if (!isRecord(monitor)) return [];
      if (
        typeof monitor.monitor_id !== "string" ||
        typeof monitor.reason !== "string"
      ) {
        return [];
      }
      return [{ monitorId: monitor.monitor_id, reason: monitor.reason }];
    });
  if (
    surfaces.length !== Math.min(rawSurfaces.length, 100) ||
    collapsedMonitors.length !== Math.min(rawCollapsedMonitors.length, 100) ||
    paneCount < rawSurfaces.length ||
    collapsed < rawCollapsedMonitors.length
  ) {
    return unavailableSelfHeal("self-heal state malformed in control_health");
  }
  const registryError =
    typeof registry.error === "string" ? registry.error : undefined;
  const ok = paneCount === 0 && registryAvailable && collapsed === 0;
  return {
    available: true,
    ok,
    panePtyDead: {
      count: paneCount,
      surfaces,
      truncated:
        pane.truncated === true ||
        rawSurfaces.length > 100 ||
        paneCount > surfaces.length,
    },
    monitorRegistry: {
      available: registryAvailable,
      ...(registryError ? { error: registryError } : {}),
      total,
      rearming,
      collapsed,
      collapsedMonitors,
      truncated:
        registry.truncated === true ||
        rawCollapsedMonitors.length > 100 ||
        collapsed > collapsedMonitors.length,
    },
    note: ok
      ? "pane write-liveness and monitor reconciliation healthy"
      : registryAvailable
        ? "pane write-liveness or monitor reconciliation requires attention"
        : `monitor registry unavailable: ${registryError ?? "unknown error"}`,
  };
}

function daemonProbeError(message: unknown): string {
  return message instanceof Error ? message.message : String(message);
}

function daemonScriptPathFromPs(ps: string): string | null {
  return ps.match(/(?:^|\s)(\/[^\s]*\/daemon\.js)(?:\s|$)/)?.[1] ?? null;
}

function probeDaemonMcp(
  socketPath: string,
  timeoutMs: number,
): Promise<DaemonMcpProbeResult> {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection(socketPath);
    let connected = false;
    let settled = false;
    let buffer = "";
    let version: string | null = null;
    const settle = (result: DaemonMcpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolveProbe(result);
    };
    const send = (message: Record<string, unknown>) => {
      socket.write(`${JSON.stringify(message)}\n`);
    };
    const timeout = setTimeout(() => {
      settle(
        connected
          ? {
              kind: "error",
              error: `daemon probe timed out after ${timeoutMs}ms`,
            }
          : { kind: "not-listening" },
      );
    }, timeoutMs);

    socket.once("connect", () => {
      connected = true;
      try {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "cmuxlayer-doctor", version: "1" },
          },
        });
      } catch (error) {
        settle({ kind: "error", error: daemonProbeError(error) });
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.error) {
            settle({
              kind: "error",
              error: `daemon RPC error: ${JSON.stringify(message.error)}`,
            });
            return;
          }
          if (message.id === 1) {
            const result = isRecord(message.result) ? message.result : null;
            const serverInfo =
              result && isRecord(result.serverInfo) ? result.serverInfo : null;
            version =
              serverInfo && typeof serverInfo.version === "string"
                ? serverInfo.version
                : null;
            if (!version) {
              settle({
                kind: "error",
                error: "daemon initialize response missing serverInfo.version",
              });
              return;
            }
            send({
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {},
            });
            send({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "control_health", arguments: {} },
            });
          } else if (message.id === 2) {
            const result = isRecord(message.result) ? message.result : null;
            const structured =
              result && isRecord(result.structuredContent)
                ? result.structuredContent
                : null;
            const health =
              structured && isRecord(structured.health)
                ? structured.health
                : null;
            const selected =
              health && isRecord(health.selected_transport)
                ? health.selected_transport
                : null;
            const currentProcess =
              health && isRecord(health.current_process)
                ? health.current_process
                : null;
            const scriptPath =
              currentProcess && typeof currentProcess.script_path === "string"
                ? currentProcess.script_path
                : currentProcess && typeof currentProcess.ps === "string"
                  ? daemonScriptPathFromPs(currentProcess.ps)
                  : null;
            if (!version || !selected) {
              settle({
                kind: "error",
                error: "daemon control_health response missing selected_transport",
              });
              return;
            }
            settle({
              kind: "responding",
              version,
              transportDegraded: selected.transport_degraded === true,
              currentSocketPath:
                typeof selected.current_socket_path === "string"
                  ? selected.current_socket_path
                  : null,
              scriptPath,
              selfHeal: parseDoctorSelfHeal(health?.self_heal),
            });
          }
        } catch (error) {
          settle({
            kind: "error",
            error: `daemon probe parse failure: ${daemonProbeError(error)}`,
          });
          return;
        }
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        settle({ kind: "not-listening" });
        return;
      }
      settle({ kind: "error", error: daemonProbeError(error) });
    });
    socket.once("close", () => {
      if (!settled) {
        settle({
          kind: connected ? "error" : "not-listening",
          ...(connected ? { error: "daemon closed during MCP probe" } : {}),
        } as DaemonMcpProbeResult);
      }
    });
  });
}

async function checkDaemonIntegrity(
  opts: RunDoctorOptions,
  env: NodeJS.ProcessEnv,
): Promise<{
  daemon: DoctorReport["daemon"];
  selfHeal: DoctorSelfHealReport;
}> {
  const socketPath = defaultDaemonSocketPath(env);
  const probe = await probeDaemonMcp(
    socketPath,
    opts.daemonProbeTimeoutMs ?? 1_500,
  );
  if (probe.kind === "not-listening") {
    return {
      daemon: {
        applicable: true,
        ok: true,
        listening: false,
        socketPath,
        note: "no daemon running (starts on demand)",
      },
      selfHeal: unavailableSelfHeal("no daemon running (starts on demand)"),
    };
  }
  if (probe.kind === "error") {
    return {
      daemon: {
        applicable: true,
        ok: false,
        listening: true,
        socketPath,
        note: `daemon probe failed: ${probe.error}`,
      },
      selfHeal: unavailableSelfHeal("daemon control_health probe failed"),
    };
  }

  const detect = opts.detectStaleBuild ?? detectStaleBuild;
  const stale = detect({ running: probe.version });
  const base = {
    applicable: true as const,
    listening: true,
    socketPath,
    runningVersion: probe.version,
    ...(stale ? { installedVersion: stale.installed } : {}),
    transportDegraded: probe.transportDegraded,
    currentSocketPath: probe.currentSocketPath,
    ...(probe.scriptPath ? { runningScriptPath: probe.scriptPath } : {}),
  };
  if (probe.scriptPath) {
    try {
      if (!(opts.pathExists ?? existsSync)(probe.scriptPath)) {
        return {
          daemon: {
            ...base,
            ok: false,
            note: "daemon running from a deleted install (brew cleanup?) — stale detection is blind; retire it",
          },
          selfHeal: probe.selfHeal,
        };
      }
    } catch {
      // Provenance checks are best-effort; other daemon checks still run.
    }
  }
  if (stale?.stale) {
    return {
      daemon: {
        ...base,
        ok: false,
        note: `stale daemon v${stale.running} serving (installed v${stale.installed}) — kill it; proxies respawn the installed daemon`,
      },
      selfHeal: probe.selfHeal,
    };
  }

  if (probe.transportDegraded) {
    const pinnedSocketPath = env.CMUX_SOCKET_PATH?.trim();
    const cmuxSocketPath = pinnedSocketPath || probe.currentSocketPath;
    let cmuxSocketUsable = false;
    try {
      if (cmuxSocketPath) {
        const cmuxProbe = await (
          opts.probeCmuxSocket ?? ((path) => probeSocketHealth(path))
        )(cmuxSocketPath);
        cmuxSocketUsable = cmuxProbe.usable;
      }
    } catch {
      // A failed probe is the socket-down branch, but degraded is always red.
    }
    return {
      daemon: {
        ...base,
        ok: false,
        note: cmuxSocketUsable
          ? "daemon transport degraded while cmux socket alive (access-control denial class; stale-daemon-on-dead-socket class)"
          : "daemon transport degraded while cmux socket down (app not running)",
      },
      selfHeal: probe.selfHeal,
    };
  }

  return {
    daemon: {
      ...base,
      ok: true,
      note: stale
        ? `daemon v${probe.version} healthy (installed v${stale.installed})`
        : `daemon v${probe.version} healthy (installed version unavailable)`,
    },
    selfHeal: probe.selfHeal,
  };
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

function serverLauncherReference(server: unknown): string | null {
  if (!isRecord(server)) {
    return null;
  }
  const command = typeof server.command === "string" ? server.command : "";
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return [command, ...args].find(isCmuxlayerMcpLauncher) ?? null;
}

function resolveLauncherReference(reference: string): string {
  if (reference === "cmuxlayer-mcp") {
    return join(homedir(), ".golems", "bin", "cmuxlayer-mcp");
  }
  if (reference === "~/.golems/bin/cmuxlayer-mcp") {
    return join(homedir(), ".golems", "bin", "cmuxlayer-mcp");
  }
  return reference;
}

async function realMcpLauncherProbe(
  path: string,
): Promise<McpLauncherProbeReport> {
  let linkInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    linkInfo = await lstat(path);
  } catch {
    return {
      path,
      resolvedPath: null,
      ok: false,
      note: `launcher missing at ${path}; reinstall cmuxlayer launcher`,
    };
  }

  let resolvedPath = path;
  if (linkInfo.isSymbolicLink()) {
    try {
      resolvedPath = await realpath(path);
    } catch {
      return {
        path,
        resolvedPath: null,
        ok: false,
        note: `launcher has a dangling symlink at ${path}; reinstall cmuxlayer launcher`,
      };
    }
  }

  try {
    const target = await stat(resolvedPath);
    if (!target.isFile()) {
      return {
        path,
        resolvedPath,
        ok: false,
        note: `launcher target is not a file at ${resolvedPath}; reinstall cmuxlayer launcher`,
      };
    }
  } catch {
    return {
      path,
      resolvedPath,
      ok: false,
      note: `launcher target is missing at ${resolvedPath}; reinstall cmuxlayer launcher`,
    };
  }

  try {
    await access(path, fsConstants.X_OK);
  } catch {
    return {
      path,
      resolvedPath,
      ok: false,
      note: `launcher is not executable at ${path}; reinstall cmuxlayer launcher or restore its executable bit`,
    };
  }

  return {
    path,
    resolvedPath,
    ok: true,
    note: `launcher resolves to executable file ${resolvedPath}`,
  };
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
  const probeLauncher = opts.probeLauncher ?? realMcpLauncherProbe;

  let paths: string[];
  try {
    paths = await listMcpConfigPaths();
  } catch {
    paths = [];
  }

  const drifted: McpConfigDriftEntry[] = [];
  const launcherProbes = new Map<string, McpLauncherProbeReport>();
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

      const reasons = [driftReason(serverKey, server)].filter(
        (reason): reason is string => reason !== null,
      );
      const launcherReference = serverLauncherReference(server);
      if (launcherReference) {
        const launcherPath = resolveLauncherReference(launcherReference);
        let launcherProbe = launcherProbes.get(launcherPath);
        if (!launcherProbe) {
          launcherProbe = await probeLauncher(launcherPath);
          launcherProbes.set(launcherPath, launcherProbe);
        }
        if (!launcherProbe.ok) {
          reasons.push(launcherProbe.note);
        }
      }
      const reason = reasons.length > 0 ? reasons.join("; ") : null;
      if (reason) {
        drifted.push({ path, serverKey, reason });
      }
    }
  }

  const launchers = [...launcherProbes.values()];
  return {
    scanned,
    drifted,
    launcherOk: launchers.every((launcher) => launcher.ok),
    launchers,
    note: "scanned ~/Gits/*/.mcp.json for cmux/cmuxlayer entries expected to reference an existing executable launcher cmuxlayer-mcp; read-only, skipped missing/unreadable/invalid JSON",
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
  const { daemon, selfHeal } = await checkDaemonIntegrity(opts, env);

  // Brew/tap gaps stay best-effort, but an unusable referenced launcher is an
  // operational failure: configs can look correct while every MCP launch fails.
  const healthy =
    versionOk && daemon.ok && selfHeal.ok && mcpConfigDrift.launcherOk;

  return {
    healthy,
    version: { ok: versionOk, value: opts.version },
    caskSelfHeal: {
      applicable: false,
      note: "not-applicable: stdio MCP, no cask (§1 account-rename self-heal)",
    },
    daemon,
    selfHeal,
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

  lines.push(`│ ${mark(report.daemon.ok)} §5 ${report.daemon.note}`);
  if (!report.selfHeal.available) {
    lines.push(`│ — §5 self-heal observability: ${report.selfHeal.note}`);
  } else {
    const paneDetails = report.selfHeal.panePtyDead.surfaces
      .map((surface) =>
        surface.sinceAt
          ? `${surface.surfaceId} since ${surface.sinceAt} (last attempt ${surface.lastAttemptAt})`
          : `${surface.surfaceId} last attempt ${surface.lastAttemptAt}`,
      )
      .join(", ");
    lines.push(
      `│ ${mark(report.selfHeal.panePtyDead.count === 0)}    pane_pty_dead: ${
        report.selfHeal.panePtyDead.count === 0
          ? "none"
          : `${report.selfHeal.panePtyDead.count} (${paneDetails || "details unavailable"})`
      }${report.selfHeal.panePtyDead.truncated ? " [details truncated]" : ""}`,
    );
    if (!report.selfHeal.monitorRegistry.available) {
      lines.push(
        `│ ✗    monitor registry: unavailable (${report.selfHeal.monitorRegistry.error ?? "unknown error"})`,
      );
    } else {
      const collapsedDetails = report.selfHeal.monitorRegistry.collapsedMonitors
        .map((monitor) => `${monitor.monitorId}: ${monitor.reason}`)
        .join(", ");
      lines.push(
        `│ ${mark(report.selfHeal.monitorRegistry.collapsed === 0)}    monitor registry: total=${report.selfHeal.monitorRegistry.total} rearming=${report.selfHeal.monitorRegistry.rearming} collapsed=${report.selfHeal.monitorRegistry.collapsed}${
          report.selfHeal.monitorRegistry.collapsed > 0
            ? `; collapsed monitors: ${collapsedDetails || "details unavailable"}`
            : ""
        }${report.selfHeal.monitorRegistry.truncated ? " [details truncated]" : ""}`,
      );
    }
  }

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

  for (const launcher of report.mcpConfigDrift.launchers) {
    lines.push(
      `│ ${mark(launcher.ok)} launcher: ${launcher.path} — ${launcher.note}`,
    );
  }

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
