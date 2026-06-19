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
import { homedir } from "node:os";
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

interface CliOptions {
  dryRun: boolean;
  graceSeconds: number;
  logFile: string;
  minAgeSeconds: number;
  knownServerNames: readonly string[];
}

export interface SignalAttempt {
  ok: boolean;
  pid: number;
  signal: NodeJS.Signals;
  errorCode?: string;
  errorMessage?: string;
}

export type KillProcess = (pid: number, signal: NodeJS.Signals) => void;

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
const MCP_SERVER_ENTRYPOINT_PATTERN =
  /(?:^|[\/\s])(?:dist|build|lib)\/(?:index|server|mcp-server)\.(?:js|mjs|cjs)(?:$|[\s"'`])/i;

export function selectReapablePids(
  procList: readonly ProcessInfo[],
  opts: SelectReapableOptions = {},
): number[] {
  const minAgeSeconds = opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS;
  const knownServerNames =
    opts.knownServerNames ?? DEFAULT_KNOWN_SERVER_NAMES;

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
    MCP_PACKAGE_NAME_PATTERN.test(command) &&
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
    timeParts.length === 3
      ? timeParts
      : [0, timeParts[0], timeParts[1]];
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
): SignalAttempt[] {
  return processes.map((proc) => {
    try {
      killProcess(proc.pid, signal);
      return { ok: true, pid: proc.pid, signal };
    } catch (error) {
      return {
        ok: false,
        pid: proc.pid,
        signal,
        errorCode: signalErrorCode(error),
        errorMessage:
          error instanceof Error ? error.message : String(error),
      };
    }
  });
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
  const { stdout } = await execFileAsync("ps", [
    "-axo",
    "pid=,ppid=,etime=,command=",
  ]);
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

export function parseCliOptions(argv: readonly string[]): CliOptions {
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
  logFile: string,
  attempts: readonly SignalAttempt[],
): Promise<void> {
  for (const attempt of attempts) {
    if (attempt.ok) {
      continue;
    }
    const line = `SIGNAL_FAILED signal=${attempt.signal} pid=${attempt.pid} code=${attempt.errorCode ?? "UNKNOWN"} message=${attempt.errorMessage ?? ""}`;
    console.error(line);
    await appendLogLine(logFile, line);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runReaper(opts: CliOptions): Promise<void> {
  const processes = await readProcessTable();
  const reapablePids = new Set(
    selectReapablePids(processes, {
      knownServerNames: opts.knownServerNames,
      minAgeSeconds: opts.minAgeSeconds,
    }),
  );
  const reapable = processes.filter((proc) => reapablePids.has(proc.pid));

  if (reapable.length === 0) {
    console.log("No reapable ppid=1 idle node MCP orphans found.");
    return;
  }

  for (const proc of reapable) {
    const line = `${opts.dryRun ? "DRY_RUN would terminate" : "SIGTERM"} ${formatProcess(proc)}`;
    console.log(line);
    await appendLogLine(opts.logFile, line);
  }

  if (opts.dryRun) {
    return;
  }

  await logSignalFailures(
    opts.logFile,
    signalProcessBatch(reapable, "SIGTERM"),
  );

  await sleep(opts.graceSeconds * 1000);

  const afterGrace = await readProcessTable();
  const stillReapablePids = new Set(
    selectReapablePids(afterGrace, {
      knownServerNames: opts.knownServerNames,
      minAgeSeconds: opts.minAgeSeconds,
    }),
  );
  const killable = afterGrace.filter(
    (proc) => reapablePids.has(proc.pid) && stillReapablePids.has(proc.pid),
  );

  for (const proc of killable) {
    const line = `SIGKILL ${formatProcess(proc)}`;
    console.log(line);
    await appendLogLine(opts.logFile, line);
  }
  await logSignalFailures(
    opts.logFile,
    signalProcessBatch(killable, "SIGKILL"),
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
