import { execFile } from "node:child_process";
import { getTransportHealth } from "./cmux-transport-self-heal.js";
import {
  constants as fsConstants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  queryMonitorRegistryForGates,
  readMonitorRegistry,
  type MonitorRegistryOptions,
} from "./monitor-registry.js";
import type { SurfaceWriteLivenessTracker } from "./surface-write-liveness.js";

const MAX_SELF_HEAL_DETAILS = 100;
const MAX_MONITOR_REGISTRY_BYTES = 1024 * 1024;

const RUNNING_SCRIPT_PATH = (() => {
  const entrypoint = process.argv[1];
  if (!entrypoint) return null;
  try {
    return realpathSync(entrypoint);
  } catch {
    return resolve(entrypoint);
  }
})();

export interface ControlHealthExecResult {
  stdout: string;
  stderr?: string;
}

export type ControlHealthExecFile = (
  file: string,
  args: string[],
) => Promise<ControlHealthExecResult>;

export interface ControlHealthOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  tmpDir?: string;
  pid?: number;
  ppid?: number;
  cwd?: string;
  scriptPath?: string | null;
  client?: unknown;
  execFile?: ControlHealthExecFile;
  readFile?: typeof readFile;
  stat?: typeof stat;
  access?: typeof access;
  now?: () => Date;
  surfaceWriteLiveness?: SurfaceWriteLivenessTracker;
  surfaceIds?: readonly string[];
  panePtyDeadSince?: ReadonlyMap<string, number>;
  monitorRegistryPath?: string;
}

export interface ControlHealthSelfHeal {
  pane_pty_dead: {
    count: number;
    surfaces: Array<{
      surface_id: string;
      since_at?: string;
      last_attempt_at: string;
    }>;
    truncated: boolean;
  };
  monitor_registry: {
    available: boolean;
    error?: string;
    total: number;
    rearming: number;
    collapsed: number;
    collapsed_monitors: Array<{ monitor_id: string; reason: string }>;
    truncated: boolean;
  };
}

export interface PathStatus {
  path: string;
  exists: boolean;
  kind?: "file" | "directory" | "socket" | "other";
  mtime_ms?: number;
  size?: number;
  mode_octal?: string;
  error?: string;
}

export interface MarkerStatus extends PathStatus {
  label: string;
  value?: string;
}

export interface ExecutableStatus extends PathStatus {
  first_line?: string;
  mentions_prod_app?: boolean;
  mentions_nightly_app?: boolean;
  mentions_last_cli_path?: boolean;
}

export interface CmuxInstanceHealth {
  axis: "production" | "nightly";
  app_bundle_path: string;
  app_binary_path: string;
  marker_files: MarkerStatus[];
  socket_path: string | null;
  socket_status: PathStatus | null;
  processes: Array<{ pid: number | null; command: string }>;
}

export interface ControlHealth {
  generated_at: string;
  current_process: {
    pid: number;
    ppid: number;
    cwd: string;
    stdin_is_tty: boolean;
    env: Record<string, string | null>;
    path_entries: string[];
    cmux_resolution: ExecutableStatus[];
    ps?: string;
    ps_error?: string;
    script_path?: string | null;
  };
  selected_transport: {
    client_class: string | null;
    current_socket_path?: string;
    transport_mode?: "socket" | "cli";
    transport_degraded?: boolean;
    transport_denied?: "access-control";
    transport_error?: string;
  };
  cmux_instances: {
    production: CmuxInstanceHealth;
    nightly: CmuxInstanceHealth;
  };
  self_heal: ControlHealthSelfHeal;
  warnings: string[];
}

export function collectSelfHealHealth(opts: {
  surfaceWriteLiveness?: SurfaceWriteLivenessTracker;
  surfaceIds?: readonly string[];
  panePtyDeadSince?: ReadonlyMap<string, number>;
  monitorRegistry?: MonitorRegistryOptions;
} = {}): ControlHealthSelfHeal {
  const surfaceIds = [...new Set(opts.surfaceIds ?? [])];
  const deadSurfaces: ControlHealthSelfHeal["pane_pty_dead"]["surfaces"] = [];
  let deadSurfaceCount = 0;
  if (opts.surfaceWriteLiveness) {
    for (const surfaceId of surfaceIds) {
      try {
        const observation = opts.surfaceWriteLiveness.observe(surfaceId);
        if (!observation?.pty_dead) continue;
        deadSurfaceCount += 1;
        if (deadSurfaces.length >= MAX_SELF_HEAL_DETAILS) continue;
        const sinceAt = opts.panePtyDeadSince?.get(surfaceId);
        deadSurfaces.push({
          surface_id: surfaceId,
          ...(sinceAt === undefined
            ? {}
            : { since_at: new Date(sinceAt).toISOString() }),
          last_attempt_at: new Date(
            observation.last_attempt_at,
          ).toISOString(),
        });
      } catch {
        // One malformed/stale surface observation must not break control_health.
      }
    }
  }

  let monitors: ReturnType<typeof readMonitorRegistry>["monitors"] = [];
  let monitorRegistryAvailable = false;
  let monitorRegistryError: string | undefined;
  const registryPath = opts.monitorRegistry?.registryPath;
  if (registryPath) {
    try {
      const registryStat = statSync(registryPath);
      if (registryStat.size > MAX_MONITOR_REGISTRY_BYTES) {
        throw new Error(
          `monitor registry exceeds ${MAX_MONITOR_REGISTRY_BYTES} bytes`,
        );
      }
      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as { monitors?: unknown }).monitors)
      ) {
        throw new Error("monitor registry JSON has invalid shape");
      }
      const registryQuery = queryMonitorRegistryForGates(
        opts.monitorRegistry,
      );
      if (
        registryQuery.monitors.some(
          (monitor) => monitor.liveness === "invalid",
        )
      ) {
        throw new Error("monitor registry contains invalid records");
      }
      monitors = readMonitorRegistry(opts.monitorRegistry).monitors;
      monitorRegistryAvailable = true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        monitors = readMonitorRegistry(opts.monitorRegistry).monitors;
        monitorRegistryAvailable = true;
      } else {
        monitorRegistryError =
          error instanceof Error ? error.message : String(error);
      }
    }
  } else {
    monitorRegistryError = "monitor registry path is not configured";
  }
  const collapsedMonitors = monitors
    .filter((monitor) => monitor.state === "collapsed")
    .map((monitor) => ({
      monitor_id: monitor.monitor_id,
      reason: monitor.collapsed_reason ?? "unknown",
    }));

  return {
    pane_pty_dead: {
      count: deadSurfaceCount,
      surfaces: deadSurfaces,
      truncated: deadSurfaceCount > deadSurfaces.length,
    },
    monitor_registry: {
      available: monitorRegistryAvailable,
      ...(monitorRegistryError ? { error: monitorRegistryError } : {}),
      total: monitors.length,
      rearming: monitors.filter((monitor) => monitor.state === "rearming").length,
      collapsed: collapsedMonitors.length,
      collapsed_monitors: collapsedMonitors.slice(0, MAX_SELF_HEAL_DETAILS),
      truncated: collapsedMonitors.length > MAX_SELF_HEAL_DETAILS,
    },
  };
}

const ENV_KEYS = [
  "CMUX_SOCKET_PATH",
  "CMUX_BUNDLED_CLI_PATH",
  "CMUX_BUNDLE_ID",
  "CMUX_WORKSPACE_ID",
  "CMUX_SURFACE_ID",
  "CMUX_TAB_ID",
  "CMUX_CLAUDE_WRAPPER_SHIM_ROOT",
  "CMUX_SOCKET_PASSWORD",
  "PATH",
] as const;

function defaultExecFile(
  file: string,
  args: string[],
): Promise<ControlHealthExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 1500, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as Error & { stdout?: string; stderr?: string };
          err.stdout = typeof stdout === "string" ? stdout : String(stdout);
          err.stderr = typeof stderr === "string" ? stderr : String(stderr);
          reject(err);
          return;
        }

        resolve({
          stdout: typeof stdout === "string" ? stdout : String(stdout),
          stderr: typeof stderr === "string" ? stderr : String(stderr),
        });
      },
    );
  });
}

function cleanText(value: string): string {
  return value.replace(/\0/g, "").trim();
}

function redactEnvValue(key: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (/PASSWORD|TOKEN|SECRET/i.test(key)) {
    return value.length > 0 ? "<set>" : "";
  }
  return value;
}

async function inspectPath(
  path: string,
  statFn: typeof stat,
): Promise<PathStatus> {
  try {
    const stats = await statFn(path);
    const kind = stats.isSocket()
      ? "socket"
      : stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : "other";
    return {
      path,
      exists: true,
      kind,
      mtime_ms: stats.mtimeMs,
      size: stats.size,
      mode_octal: `0${(stats.mode & 0o777).toString(8)}`,
    };
  } catch (error) {
    return {
      path,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readMarker(
  label: string,
  path: string,
  deps: Pick<Required<ControlHealthOptions>, "readFile" | "stat">,
): Promise<MarkerStatus> {
  const status = await inspectPath(path, deps.stat);
  if (!status.exists) {
    return { ...status, label };
  }

  try {
    const raw = await deps.readFile(path, "utf8");
    const value = cleanText(raw);
    return { ...status, label, value: value.length > 0 ? value : undefined };
  } catch (error) {
    return {
      ...status,
      label,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function splitPathEntries(pathValue: string | undefined): string[] {
  return (pathValue ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function inspectExecutable(
  path: string,
  deps: Pick<Required<ControlHealthOptions>, "readFile" | "stat" | "access">,
): Promise<ExecutableStatus | null> {
  try {
    await deps.access(path, fsConstants.X_OK);
  } catch {
    return null;
  }

  const status = await inspectPath(path, deps.stat);
  let firstLine: string | undefined;
  let sample = "";
  try {
    const raw = await deps.readFile(path);
    sample = raw.subarray(0, 4096).toString("utf8");
    if (!sample.includes("\0")) {
      firstLine = sample.split(/\r?\n/, 1)[0]?.slice(0, 240);
    }
  } catch {
    // Executable metadata is still useful when the file cannot be sampled.
  }

  return {
    ...status,
    first_line: firstLine,
    mentions_prod_app: sample.includes("/Applications/cmux.app"),
    mentions_nightly_app: sample.includes("/Applications/cmux NIGHTLY.app"),
    mentions_last_cli_path: sample.includes("/tmp/cmux-last-cli-path"),
  };
}

async function resolveExecutables(
  command: string,
  pathEntries: string[],
  deps: Pick<Required<ControlHealthOptions>, "readFile" | "stat" | "access">,
): Promise<ExecutableStatus[]> {
  const seen = new Set<string>();
  const found: ExecutableStatus[] = [];

  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const inspected = await inspectExecutable(candidate, deps);
    if (inspected) found.push(inspected);
  }

  return found;
}

async function runOptional(
  execFileFn: ControlHealthExecFile,
  file: string,
  args: string[],
): Promise<{ stdout?: string; error?: string }> {
  try {
    const result = await execFileFn(file, args);
    return { stdout: result.stdout.trim() };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const detail = [err.message, err.stderr?.trim(), err.stdout?.trim()]
      .filter((part): part is string => Boolean(part))
      .join(": ");
    return { error: detail || String(error) };
  }
}

function parsePgrepOutput(
  output: string | undefined,
): Array<{ pid: number | null; command: string }> {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      return {
        pid: match ? Number(match[1]) : null,
        command: match ? match[2] : line,
      };
    });
}

function selectSocketPath(markers: MarkerStatus[], fallback: string): string {
  return markers.find((marker) => marker.value)?.value ?? fallback;
}

function describeClient(client: unknown): ControlHealth["selected_transport"] {
  const record =
    client && typeof client === "object"
      ? (client as Record<string, unknown>)
      : null;
  const currentSocketPath =
    record && typeof record.currentSocketPath === "function"
      ? (record.currentSocketPath as () => unknown).call(client)
      : undefined;
  const transportHealth = getTransportHealth(client);

  return {
    client_class:
      client && typeof client === "object"
        ? ((client as { constructor?: { name?: string } }).constructor?.name ??
          null)
        : null,
    ...(typeof currentSocketPath === "string"
      ? { current_socket_path: currentSocketPath }
      : transportHealth?.current_socket_path
        ? { current_socket_path: transportHealth.current_socket_path }
        : {}),
    ...(transportHealth
      ? {
          transport_mode: transportHealth.mode,
          transport_degraded: transportHealth.degraded,
          ...(transportHealth.denied_reason
            ? { transport_denied: transportHealth.denied_reason }
            : {}),
          ...(transportHealth.last_error
            ? { transport_error: transportHealth.last_error }
            : {}),
        }
      : {}),
  };
}

function buildWarnings(health: Omit<ControlHealth, "warnings">): string[] {
  const warnings: string[] = [];
  const envSocket = health.current_process.env.CMUX_SOCKET_PATH;
  const bundledCli = health.current_process.env.CMUX_BUNDLED_CLI_PATH;
  const firstCmux = health.current_process.cmux_resolution[0];
  const nightlySocket = health.cmux_instances.nightly.socket_path;
  const prodSocket = health.cmux_instances.production.socket_path;

  if (
    envSocket &&
    nightlySocket &&
    envSocket === nightlySocket &&
    firstCmux?.mentions_prod_app &&
    !firstCmux.mentions_nightly_app
  ) {
    warnings.push(
      "CMUX_SOCKET_PATH points at Nightly, but the first cmux executable resolves through a prod app shim/binary.",
    );
  }

  if (
    bundledCli?.includes("cmux NIGHTLY.app") &&
    firstCmux &&
    !firstCmux.path.includes("cmux NIGHTLY.app") &&
    !firstCmux.mentions_nightly_app
  ) {
    warnings.push(
      "CMUX_BUNDLED_CLI_PATH is Nightly, but PATH resolves cmux somewhere else first.",
    );
  }

  if (
    health.selected_transport.current_socket_path &&
    envSocket &&
    health.selected_transport.current_socket_path !== envSocket
  ) {
    warnings.push(
      "cmuxlayer selected socket path differs from process CMUX_SOCKET_PATH.",
    );
  }

  if (
    prodSocket &&
    nightlySocket &&
    prodSocket !== nightlySocket &&
    health.selected_transport.current_socket_path === prodSocket &&
    envSocket === nightlySocket
  ) {
    warnings.push(
      "cmuxlayer is attached to the production socket while the process env points at Nightly.",
    );
  }

  if (
    health.selected_transport.transport_denied === "access-control" &&
    health.selected_transport.transport_error
  ) {
    warnings.push(
      `cmuxlayer control transport denied: access-control; ${health.selected_transport.transport_error}`,
    );
  } else if (
    health.selected_transport.transport_degraded === true &&
    !warnings.some((warning) => warning.includes("transport degraded"))
  ) {
    warnings.push(
      "cmuxlayer control transport is degraded on CLI fallback; socket re-probe is active.",
    );
  }

  return warnings;
}

export async function collectControlHealth(
  opts: ControlHealthOptions = {},
): Promise<ControlHealth> {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const tmpDir = opts.tmpDir ?? "/tmp";
  const deps = {
    execFile: opts.execFile ?? defaultExecFile,
    readFile: opts.readFile ?? readFile,
    stat: opts.stat ?? stat,
    access: opts.access ?? access,
  };
  const stateDir = join(homeDir, ".local", "state", "cmux");
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const prodDefaultSocket =
    uid === undefined
      ? join(stateDir, "cmux.sock")
      : join(stateDir, `cmux-${uid}.sock`);
  const nightlyDefaultSocket = join(tmpDir, "cmux-nightly.sock");
  const pathEntries = splitPathEntries(env.PATH);

  const [prodMarkers, nightlyMarkers, cmuxResolution, processList, ps] =
    await Promise.all([
      Promise.all([
        readMarker(
          "state_last_socket",
          join(stateDir, "last-socket-path"),
          deps,
        ),
        readMarker(
          "tmp_last_socket",
          join(tmpDir, "cmux-last-socket-path"),
          deps,
        ),
      ]),
      Promise.all([
        readMarker(
          "state_nightly_last_socket",
          join(stateDir, "nightly-last-socket-path"),
          deps,
        ),
        readMarker(
          "tmp_nightly_last_socket",
          join(tmpDir, "cmux-nightly-last-socket-path"),
          deps,
        ),
      ]),
      resolveExecutables("cmux", pathEntries, deps),
      runOptional(deps.execFile, "ps", ["ax", "-o", "pid=", "-o", "command="]),
      runOptional(deps.execFile, "ps", [
        "-o",
        "pid=",
        "-o",
        "ppid=",
        "-o",
        "pgid=",
        "-o",
        "tpgid=",
        "-o",
        "stat=",
        "-o",
        "tty=",
        "-o",
        "command=",
        "-p",
        String(opts.pid ?? process.pid),
      ]),
    ]);

  const prodSocket = selectSocketPath(prodMarkers, prodDefaultSocket);
  const nightlySocket = selectSocketPath(nightlyMarkers, nightlyDefaultSocket);
  const allProcesses = parsePgrepOutput(processList.stdout).filter((proc) =>
    /\/Applications\/cmux|cmux NIGHTLY|cmux\.app/.test(proc.command),
  );
  const envSnapshot = Object.fromEntries(
    ENV_KEYS.map((key) => [key, redactEnvValue(key, env[key])]),
  ) as Record<string, string | null>;

  const base: Omit<ControlHealth, "warnings"> = {
    generated_at: (opts.now ?? (() => new Date()))().toISOString(),
    current_process: {
      pid: opts.pid ?? process.pid,
      ppid: opts.ppid ?? process.ppid,
      cwd: opts.cwd ?? process.cwd(),
      script_path:
        opts.scriptPath === undefined ? RUNNING_SCRIPT_PATH : opts.scriptPath,
      stdin_is_tty: process.stdin.isTTY === true,
      env: envSnapshot,
      path_entries: pathEntries,
      cmux_resolution: cmuxResolution,
      ...(ps.stdout ? { ps: ps.stdout } : {}),
      ...(ps.error ? { ps_error: ps.error } : {}),
    },
    selected_transport: describeClient(opts.client),
    cmux_instances: {
      production: {
        axis: "production",
        app_bundle_path: "/Applications/cmux.app",
        app_binary_path: "/Applications/cmux.app/Contents/MacOS/cmux",
        marker_files: prodMarkers,
        socket_path: prodSocket,
        socket_status: await inspectPath(prodSocket, deps.stat),
        processes: allProcesses.filter(
          (proc) =>
            proc.command.includes("/Applications/cmux.app") &&
            !proc.command.includes("cmux NIGHTLY.app"),
        ),
      },
      nightly: {
        axis: "nightly",
        app_bundle_path: "/Applications/cmux NIGHTLY.app",
        app_binary_path: "/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux",
        marker_files: nightlyMarkers,
        socket_path: nightlySocket,
        socket_status: await inspectPath(nightlySocket, deps.stat),
        processes: allProcesses.filter((proc) =>
          proc.command.includes("cmux NIGHTLY.app"),
        ),
      },
    },
    self_heal: collectSelfHealHealth({
      surfaceWriteLiveness: opts.surfaceWriteLiveness,
      surfaceIds: opts.surfaceIds,
      panePtyDeadSince: opts.panePtyDeadSince,
      monitorRegistry: opts.monitorRegistryPath
        ? { registryPath: opts.monitorRegistryPath }
        : undefined,
    }),
  };

  return { ...base, warnings: buildWarnings(base) };
}

function formatInstance(instance: CmuxInstanceHealth): string[] {
  const processSummary =
    instance.processes.length > 0
      ? instance.processes
          .map((proc) => (proc.pid === null ? "unknown" : String(proc.pid)))
          .join(", ")
      : "none detected";
  const socket = instance.socket_status;
  const socketSummary = socket
    ? `${socket.path} (${socket.exists ? socket.kind : "missing"})`
    : "none";
  return [
    `${instance.axis}:`,
    `  socket: ${socketSummary}`,
    `  app: ${instance.app_binary_path}`,
    `  pids: ${processSummary}`,
  ];
}

export function formatControlHealth(health: ControlHealth): string {
  const lines = [
    "cmuxlayer control_health",
    `generated_at: ${health.generated_at}`,
    `transport: ${health.selected_transport.client_class ?? "unknown"}${
      health.selected_transport.current_socket_path
        ? ` (${health.selected_transport.current_socket_path})`
        : ""
    }`,
    ...(health.selected_transport.transport_denied
      ? [
          `transport_denied: ${health.selected_transport.transport_denied}`,
          `transport_error: ${health.selected_transport.transport_error ?? "unknown"}`,
        ]
      : []),
    `env CMUX_SOCKET_PATH: ${health.current_process.env.CMUX_SOCKET_PATH ?? "unset"}`,
    `env CMUX_BUNDLED_CLI_PATH: ${health.current_process.env.CMUX_BUNDLED_CLI_PATH ?? "unset"}`,
    "cmux resolution:",
    ...health.current_process.cmux_resolution
      .slice(0, 5)
      .map((entry, index) => {
        const flags = [
          entry.mentions_prod_app ? "prod-app" : null,
          entry.mentions_nightly_app ? "nightly-app" : null,
          entry.mentions_last_cli_path ? "last-cli-path" : null,
        ]
          .filter((value): value is string => Boolean(value))
          .join(", ");
        return `  ${index + 1}. ${entry.path}${flags ? ` [${flags}]` : ""}`;
      }),
    ...formatInstance(health.cmux_instances.production),
    ...formatInstance(health.cmux_instances.nightly),
    `pane_pty_dead: ${health.self_heal.pane_pty_dead.count}`,
    ...health.self_heal.pane_pty_dead.surfaces.map(
      (surface) =>
        `  ${surface.surface_id} since ${surface.since_at ?? surface.last_attempt_at}`,
    ),
    ...(health.self_heal.monitor_registry.available
      ? [
          `monitor registry: total=${health.self_heal.monitor_registry.total} rearming=${health.self_heal.monitor_registry.rearming} collapsed=${health.self_heal.monitor_registry.collapsed}`,
        ]
      : [
          `monitor registry: unavailable (${health.self_heal.monitor_registry.error ?? "unknown error"})`,
        ]),
    ...health.self_heal.monitor_registry.collapsed_monitors.map(
      (monitor) => `  ${monitor.monitor_id}: ${monitor.reason}`,
    ),
  ];

  if (health.current_process.cmux_resolution.length === 0) {
    lines.push("  none");
  }

  if (health.warnings.length > 0) {
    lines.push("warnings:");
    lines.push(...health.warnings.map((warning) => `  - ${warning}`));
  }

  return lines.join("\n");
}
