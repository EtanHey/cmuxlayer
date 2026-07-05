#!/usr/bin/env node
/**
 * cmuxlayer MCP orphan reaper
 *
 * What it targets:
 * - node processes whose argv matches a tight MCP server pattern or known MCP
 *   server allowlist,
 * - whose parent is pid 1,
 * - whose elapsed age is at least REAPER_MIN_AGE_SECONDS, default 600 seconds.
 *
 * Dry-run is the default. With no flags, the reaper logs and prints what it
 * would terminate, but sends no signals. To actually reap processes, pass
 * --execute or set REAPER_DRY_RUN=0.
 *
 * Usage:
 *   scripts/mcp-orphan-reaper.sh
 *   scripts/mcp-orphan-reaper.sh --execute
 *   REAPER_MIN_AGE_SECONDS=1800 REAPER_DRY_RUN=0 scripts/mcp-orphan-reaper.sh
 *
 * launchd:
 *   Copy scripts/com.cmuxlayer.mcp-reaper.plist to ~/Library/LaunchAgents/,
 *   edit the ProgramArguments path for this checkout, then run:
 *   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cmuxlayer.mcp-reaper.plist
 *
 * This tool intentionally does not change cmuxlayer agent lifecycle semantics.
 * It only considers already-orphaned MCP server child processes.
 */

import { execFile } from "node:child_process";
import { mkdir, appendFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { freemem, homedir, totalmem } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  etimes: number;
  command: string;
  launchdManaged?: boolean;
  launchdLabel?: string;
}

export interface SelectReapableOptions {
  minAgeSeconds?: number;
  knownServerNames?: readonly string[];
}

export interface RunReaperOptions {
  dryRun: boolean;
  graceSeconds: number;
  logFile: string;
  minAgeSeconds: number;
  knownServerNames: readonly string[];
}

export interface RamEvidence {
  processRssBytes: number;
  systemFreeBytes: number;
  systemTotalBytes: number;
}

export interface RunReaperDeps {
  appendAuditLine?: (line: string) => Promise<void>;
  isProcessAlive?: IsProcessAlive;
  killProcess?: KillProcess;
  readProcessTable?: () => Promise<ProcessInfo[]>;
  readRamEvidence?: () => RamEvidence;
  sleep?: (ms: number) => Promise<void>;
  writeStderr?: (line: string) => void;
  writeStdout?: (line: string) => void;
}

export interface SignalAttempt {
  ok: boolean;
  pid: number;
  signal: NodeJS.Signals;
  errorCode?: string;
  errorMessage?: string;
}

export type KillProcess = (pid: number, signal: NodeJS.Signals) => void;
export type IsProcessAlive = (pid: number) => boolean;

export const PROCESS_TABLE_PS_ARGS = [
  "-ww",
  "-axo",
  "pid=,ppid=,etime=,command=",
] as const;

const DEFAULT_MIN_AGE_SECONDS = 600;
const DEFAULT_GRACE_SECONDS = 10;
const DEFAULT_LOG_FILE = `${homedir()}/.local/state/cmuxlayer/mcp-reaper.log`;
const DEFAULT_KNOWN_SERVER_NAMES = [
  "@modelcontextprotocol/server-",
  "brainlayer-mcp",
  "context7-mcp",
  "mcp-server-daemon",
  "voicelayer-mcp",
  "whatsapp-mcp",
] as const;
const MCP_PACKAGE_NAME_PATTERN = /-mcp(?:$|[\s/._-])/i;
// cmuxlayer is its own MCP server but its package/path is "cmuxlayer", not
// "cmuxlayer-mcp", so the -mcp gate above never matched its node entrypoint.
// Matches the dir component in both the worktree (`/Gits/cmuxlayer/dist/...`)
// and brew (`/Cellar/cmuxlayer/<ver>/libexec/dist/...`) forms.
const CMUXLAYER_PACKAGE_NAME_PATTERN = /(?:^|[\/\s])cmuxlayer(?:$|[\/\s._-])/i;
const MCP_SERVER_ENTRYPOINT_PATTERN =
  /(?:^|[\/\s])(?:dist|build|lib)\/(?:index|server|mcp-server)\.(?:js|mjs|cjs)(?:$|[\s"'`])/i;

export function selectReapablePids(
  procList: readonly ProcessInfo[],
  opts: SelectReapableOptions = {},
): number[] {
  const minAgeSeconds = opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS;
  const knownServerNames = opts.knownServerNames ?? DEFAULT_KNOWN_SERVER_NAMES;

  return procList
    .filter((proc) => proc.ppid === 1)
    .filter((proc) => proc.launchdManaged !== true)
    .filter((proc) => proc.etimes >= minAgeSeconds)
    .filter((proc) => isNodeCommand(proc.command))
    .filter((proc) => isMcpServerCommand(proc.command, knownServerNames))
    .map((proc) => proc.pid);
}

function isNodeCommand(command: string): boolean {
  const executable = command.trim().split(/\s+/, 1)[0] ?? "";
  return basename(executable) === "node";
}

function isMcpServerCommand(
  command: string,
  knownServerNames: readonly string[],
): boolean {
  if (
    (MCP_PACKAGE_NAME_PATTERN.test(command) ||
      CMUXLAYER_PACKAGE_NAME_PATTERN.test(command)) &&
    MCP_SERVER_ENTRYPOINT_PATTERN.test(command)
  ) {
    return true;
  }

  const lowered = command.toLowerCase();
  return knownServerNames
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0 && name !== "mcp")
    .some((name) => lowered.includes(name));
}

export function parseElapsedSeconds(etime: string): number {
  const trimmed = etime.trim();
  const dayParts = trimmed.split("-");
  if (dayParts.length > 2) {
    throw new Error(`Invalid ps etime value: ${etime}`);
  }

  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const timePart = dayParts[dayParts.length - 1];
  const timeParts = timePart.split(":").map((part) => Number(part));
  if (
    !Number.isInteger(days) ||
    days < 0 ||
    ![2, 3].includes(timeParts.length) ||
    timeParts.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    throw new Error(`Invalid ps etime value: ${etime}`);
  }

  const [hours, minutes, seconds] =
    timeParts.length === 3 ? timeParts : [0, timeParts[0], timeParts[1]];
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export function parseProcessLine(line: string): ProcessInfo | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }

  try {
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      etimes: parseElapsedSeconds(match[3]),
      command: match[4],
    };
  } catch {
    return null;
  }
}

export function parseLaunchdServicePids(output: string): Map<number, string> {
  const services = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+[-\d]+\s+([A-Za-z0-9_.-]+)\s*$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    if (pid > 0) {
      services.set(pid, match[2]);
    }
  }
  return services;
}

export function signalProcessBatch(
  processes: readonly ProcessInfo[],
  signal: NodeJS.Signals,
  killProcess: KillProcess = process.kill,
  isProcessAlive: IsProcessAlive = () => false,
): SignalAttempt[] {
  return processes.map((proc) => {
    try {
      killProcess(proc.pid, signal);
      if (isProcessAlive(proc.pid)) {
        return {
          ok: false,
          pid: proc.pid,
          signal,
          errorCode: "STILL_ALIVE",
          errorMessage: `pid ${proc.pid} still alive after ${signal}`,
        };
      }
      return { ok: true, pid: proc.pid, signal };
    } catch (error) {
      return {
        ok: false,
        pid: proc.pid,
        signal,
        errorCode: signalErrorCode(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

function signalErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

async function readProcessTable(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", [...PROCESS_TABLE_PS_ARGS]);
  const launchdServices = await readLaunchdServicePids();
  return stdout
    .split("\n")
    .map(parseProcessLine)
    .filter((proc): proc is ProcessInfo => proc !== null)
    .map((proc) => {
      const launchdLabel = launchdServices.get(proc.pid);
      if (!launchdLabel) {
        return proc;
      }
      return {
        ...proc,
        launchdLabel,
        launchdManaged: true,
      };
    });
}

async function readLaunchdServicePids(): Promise<Map<number, string>> {
  const domains = ["system"];
  if (typeof process.getuid === "function") {
    domains.push(`gui/${process.getuid()}`);
  }

  const services = new Map<number, string>();
  for (const domain of domains) {
    try {
      const { stdout } = await execFileAsync("launchctl", ["print", domain]);
      for (const [pid, label] of parseLaunchdServicePids(stdout)) {
        services.set(pid, label);
      }
    } catch {
      continue;
    }
  }
  return services;
}

function parseIntegerEnv(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function envDryRun(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return true;
  }
  return !["0", "false", "no"].includes(value.trim().toLowerCase());
}

export function parseCliOptions(argv: readonly string[]): RunReaperOptions {
  let dryRun = envDryRun(process.env.REAPER_DRY_RUN);
  let minAgeSeconds = parseIntegerEnv(
    process.env.REAPER_MIN_AGE_SECONDS,
    DEFAULT_MIN_AGE_SECONDS,
    "REAPER_MIN_AGE_SECONDS",
  );
  let graceSeconds = parseIntegerEnv(
    process.env.REAPER_GRACE_SECONDS,
    DEFAULT_GRACE_SECONDS,
    "REAPER_GRACE_SECONDS",
  );
  let logFile = process.env.REAPER_LOG_FILE ?? DEFAULT_LOG_FILE;
  let knownServerNames: readonly string[] = DEFAULT_KNOWN_SERVER_NAMES;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") {
      dryRun = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--min-age-seconds") {
      i += 1;
      if (!argv[i]) {
        throw new Error("--min-age-seconds requires a value");
      }
      minAgeSeconds = parseIntegerEnv(argv[i], minAgeSeconds, arg);
    } else if (arg === "--grace-seconds") {
      i += 1;
      if (!argv[i]) {
        throw new Error("--grace-seconds requires a value");
      }
      graceSeconds = parseIntegerEnv(argv[i], graceSeconds, arg);
    } else if (arg === "--log-file") {
      i += 1;
      if (!argv[i]) {
        throw new Error("--log-file requires a path");
      }
      logFile = argv[i];
    } else if (arg === "--known-server-name") {
      i += 1;
      if (!argv[i]) {
        throw new Error("--known-server-name requires a value");
      }
      knownServerNames = [...knownServerNames, argv[i]];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    dryRun,
    graceSeconds,
    knownServerNames,
    logFile,
    minAgeSeconds,
  };
}

function printUsage(): void {
  console.log(`cmuxlayer MCP orphan reaper

Dry-run by default. Pass --execute or set REAPER_DRY_RUN=0 to send signals.

Options:
  --dry-run                 Force dry-run mode
  --execute                 Send SIGTERM, then SIGKILL after grace if still safe
  --min-age-seconds <n>     Minimum process age, default ${DEFAULT_MIN_AGE_SECONDS}
  --grace-seconds <n>       Seconds between SIGTERM and SIGKILL, default ${DEFAULT_GRACE_SECONDS}
  --log-file <path>         Log file, default ${DEFAULT_LOG_FILE}
  --known-server-name <s>   Add a known MCP server name allowlist entry
`);
}

function formatProcess(proc: ProcessInfo): string {
  return `pid=${proc.pid} ppid=${proc.ppid} age=${proc.etimes}s argv=${proc.command}`;
}

async function appendLogLine(logFile: string, line: string): Promise<void> {
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, `${new Date().toISOString()} ${line}\n`);
}

async function logSignalFailures(
  attempts: readonly SignalAttempt[],
  appendAuditLine: (line: string) => Promise<void>,
  writeStderr: (line: string) => void,
): Promise<void> {
  for (const attempt of attempts) {
    if (attempt.ok) {
      continue;
    }
    const line = `SIGNAL_FAILED signal=${attempt.signal} pid=${attempt.pid} code=${attempt.errorCode ?? "UNKNOWN"} message=${attempt.errorMessage ?? ""}`;
    writeStderr(line);
    await appendAuditLine(line);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readRamEvidence(): RamEvidence {
  return {
    processRssBytes: process.memoryUsage().rss,
    systemFreeBytes: freemem(),
    systemTotalBytes: totalmem(),
  };
}

function selectReapableProcesses(
  processes: readonly ProcessInfo[],
  opts: RunReaperOptions,
): ProcessInfo[] {
  const reapablePids = new Set(
    selectReapablePids(processes, {
      knownServerNames: opts.knownServerNames,
      minAgeSeconds: opts.minAgeSeconds,
    }),
  );
  return processes.filter((proc) => reapablePids.has(proc.pid));
}

function formatAuditSnapshot(
  phase: "before" | "after",
  opts: RunReaperOptions,
  processes: readonly ProcessInfo[],
  reapable: readonly ProcessInfo[],
  ram: RamEvidence,
): string {
  const pids = reapable.map((proc) => proc.pid).join(",") || "-";
  return [
    "AUDIT",
    `phase=${phase}`,
    `dry_run=${opts.dryRun ? "true" : "false"}`,
    `total_processes=${processes.length}`,
    `reapable_processes=${reapable.length}`,
    `reapable_pids=${pids}`,
    `system_free_bytes=${ram.systemFreeBytes}`,
    `system_total_bytes=${ram.systemTotalBytes}`,
    `process_rss_bytes=${ram.processRssBytes}`,
  ].join(" ");
}

export async function runReaper(
  opts: RunReaperOptions,
  deps: RunReaperDeps = {},
): Promise<void> {
  const readTable = deps.readProcessTable ?? readProcessTable;
  const readRam = deps.readRamEvidence ?? readRamEvidence;
  const appendAuditLine =
    deps.appendAuditLine ?? ((line: string) => appendLogLine(opts.logFile, line));
  const writeStdout = deps.writeStdout ?? ((line: string) => console.log(line));
  const writeStderr = deps.writeStderr ?? ((line: string) => console.error(line));
  const sleepFor = deps.sleep ?? sleep;
  const killProcess = deps.killProcess ?? process.kill;
  const isAlive = deps.isProcessAlive ?? processAlive;

  const processes = await readTable();
  const reapable = selectReapableProcesses(processes, opts);

  if (reapable.length === 0) {
    writeStdout("No reapable ppid=1 idle node MCP orphans found.");
    return;
  }

  const initialReapablePids = new Set(reapable.map((proc) => proc.pid));
  await appendAuditLine(
    formatAuditSnapshot("before", opts, processes, reapable, readRam()),
  );

  for (const proc of reapable) {
    const line = `${opts.dryRun ? "DRY_RUN would terminate" : "SIGTERM"} ${formatProcess(proc)}`;
    writeStdout(line);
    await appendAuditLine(line);
  }

  if (opts.dryRun) {
    const afterProcesses = await readTable();
    const afterReapable = selectReapableProcesses(afterProcesses, opts);
    await appendAuditLine(
      formatAuditSnapshot("after", opts, afterProcesses, afterReapable, readRam()),
    );
    return;
  }

  await logSignalFailures(
    signalProcessBatch(reapable, "SIGTERM", killProcess),
    appendAuditLine,
    writeStderr,
  );

  await sleepFor(opts.graceSeconds * 1000);

  const afterGrace = await readTable();
  const stillReapable = selectReapableProcesses(afterGrace, opts);
  const stillReapablePids = new Set(stillReapable.map((proc) => proc.pid));
  const killable = afterGrace.filter(
    (proc) =>
      initialReapablePids.has(proc.pid) && stillReapablePids.has(proc.pid),
  );

  for (const proc of killable) {
    const line = `SIGKILL ${formatProcess(proc)}`;
    writeStdout(line);
    await appendAuditLine(line);
  }
  await logSignalFailures(
    signalProcessBatch(killable, "SIGKILL", killProcess, isAlive),
    appendAuditLine,
    writeStderr,
  );

  const finalProcesses = killable.length > 0 ? await readTable() : afterGrace;
  const finalReapable = selectReapableProcesses(finalProcesses, opts);
  await appendAuditLine(
    formatAuditSnapshot("after", opts, finalProcesses, finalReapable, readRam()),
  );
}

async function main(): Promise<void> {
  const opts = parseCliOptions(process.argv.slice(2));
  await runReaper(opts);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
