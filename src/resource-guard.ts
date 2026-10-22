import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseUnderT3Code } from './t3-code-guard.js';

export interface GuardConfig { watchdog?: boolean; guardian?: boolean; env?: Record<string, string>; }
type Duty = 'watchdog' | 'guardian' | 'reaper' | 'sampler';
type Env = NodeJS.ProcessEnv;
const cap = 5 * 1024 * 1024;

// Keep one current file and one archive, bounding even a single oversized chunk.
export function appendCapped(file: string, bytes: Buffer, limit = cap): void {
  mkdirSync(dirname(file), { recursive: true });
  for (let offset = 0; offset < bytes.length;) {
    let size = existsSync(file) ? statSync(file).size : 0;
    if (size >= limit) { renameSync(file, file + '.1'); size = 0; }
    const part = bytes.subarray(offset, offset + limit - size);
    appendFileSync(file, part);
    offset += part.length;
  }
}

function trimFile(file: string, archive = true): void {
  if (!existsSync(file) || statSync(file).size <= cap) return;
  const bytes = readFileSync(file);
  // Split at complete row boundaries without duplicating rows in the archive.
  const boundary = bytes.indexOf(10, bytes.length - cap);
  const currentStart = boundary < 0 ? bytes.length : boundary + 1;
  if (archive) {
    const start = Math.max(0, currentStart - cap);
    const archiveStart = start === 0 ? 0 : Math.max(start, bytes.indexOf(10, start) + 1);
    writeFileSync(file + '.1', bytes.subarray(archiveStart, currentStart));
  }
  writeFileSync(file, bytes.subarray(currentStart));
}

export async function runTick(options: { root: string; home?: string; config?: GuardConfig;
  run?: (name: Duty, env: Env) => Promise<void> }): Promise<void> {
  const home = options.home ?? join(homedir(), '.local/state/cmux-resource-guard');
  mkdirSync(home, { recursive: true });
  {
    const config = options.config ?? {};
    if (typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid resource guard config');
    if (config.watchdog !== undefined && typeof config.watchdog !== 'boolean' ||
        config.guardian !== undefined && typeof config.guardian !== 'boolean' ||
        config.env && (typeof config.env !== 'object' || Array.isArray(config.env) || Object.values(config.env).some(value => typeof value !== 'string'))) throw new Error('invalid resource guard config');
    const env = { ...process.env, ...config.env };
    const logs = env.CMUX_RESOURCE_GUARD_LOG_DIR ?? (options.home ? join(home, 'logs') : join(homedir(), 'Library/Logs/cmux-resource-guard'));
    env.REAPER_DRY_RUN ??= '1';
    env.REAPER_LOG_FILE ??= join(logs, 'reaper.audit.log');
    env.CMUX_MEM_WATCHDOG_LOG_DIR ??= join(logs, 'snapshots');
    env.CMUX_RAM_SAMPLER_LOG_DIR ??= logs;
    env.CMUX_RAM_SAMPLER_SAMPLE_FILE ??= join(env.CMUX_RAM_SAMPLER_LOG_DIR, 'samples.jsonl');
    env.CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE ??= join(env.CMUX_RAM_SAMPLER_LOG_DIR, 'routed-alerts.jsonl');
    env.HEAVY_ML_SAMPLE_FILE ??= env.CMUX_RAM_SAMPLER_SAMPLE_FILE;
    const state = join(home, 'tick');
    let previous = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0;
    if (!Number.isInteger(previous) || previous < 0 || previous > 29) {
      appendCapped(join(logs,'guard.err.log'), Buffer.from('invalid resource guard tick; reset to 0\n')); previous = 0;
    }
    const tick = previous + 1;
    const staged = state + '.tmp';
    writeFileSync(staged, String(tick % 30)); renameSync(staged, state);
    const duties: Duty[] = [...(config.guardian ? ['guardian' as const] : []),
      ...(config.watchdog ? ['watchdog' as const] : []), ...(tick % 30 === 0 ? ['sampler' as const] : []),
      ...(tick % 5 === 0 ? ['reaper' as const] : [])];
    const results = await Promise.allSettled(duties.map(duty =>
      (options.run ?? ((name, dutyEnv) => runDuty(options.root, name, dutyEnv, logs)))(duty, env)));
    const errors = results.flatMap((result,index) => result.status === 'rejected' ? [`${duties[index]}: ${String(result.reason)}`] : []);
    trimFile(env.REAPER_LOG_FILE);
    trimFile(env.CMUX_RAM_SAMPLER_SAMPLE_FILE);
    trimFile(env.CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE);
    const snapshots = env.CMUX_MEM_WATCHDOG_LOG_DIR;
    if (config.watchdog && existsSync(snapshots)) {
      const files = readdirSync(snapshots).filter(name => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4}\.log$/.test(name)).sort().reverse();
      for (const name of files.slice(2)) { rmSync(join(snapshots, name)); rmSync(join(snapshots, name + '.1'), { force: true }); }
      for (const name of files.slice(0, 2)) trimFile(join(snapshots, name), false);
    }
    if (errors.length) throw new Error(errors.join('; '));
  }
}

const activeGroups = new Set<number>();
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid,0); process.kill(-pid,signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
function runDuty(root: string, duty: Duty, env: Env, logs: string): Promise<void> {
  const commands: Record<Duty, string[]> = {
    watchdog: ['/bin/bash', join(root, 'launchd/resource-guard/cmux-memory-watchdog.sh')],
    guardian: ['/bin/bash', join(root, 'launchd/resource-guard/heavy-ml-guardian.sh')],
    sampler: ['/bin/bash', join(root, 'launchd/cmux-ram-sampler/bin/cmux-ram-sampler.sh')],
    reaper: [process.execPath, join(root, 'dist/mcp-reaper.js')],
  };
  return new Promise((done, fail) => {
    const [cmd, ...args] = commands[duty];
    const child = spawn(cmd, args, { env, detached:true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = child.pid;
    if (pid) activeGroups.add(pid);
    child.stdout.on('data', bytes => appendCapped(join(logs, duty + '.out.log'), bytes));
    child.stderr.on('data', bytes => appendCapped(join(logs, duty + '.err.log'), bytes));
    let closed = false, timedOut = false, escalated = false, exitCode: number | null = null;
    const budget = Number(env.CMUX_RESOURCE_GUARD_DUTY_TIMEOUT_MS ?? 45000);
    const finish = () => {
      if (!closed || timedOut && !escalated) return;
      clearTimeout(timer); if (pid) activeGroups.delete(pid);
      timedOut ? fail(new Error(`timeout after ${timeout}ms`)) : exitCode === 0 ? done() : fail(new Error(`exit ${exitCode}`));
    };
    const timeout = Number.isFinite(budget) && budget > 0 ? Math.min(45000,budget) : 45000;
    const timer = setTimeout(() => {
      timedOut = true;
      appendCapped(join(logs,duty + '.err.log'),Buffer.from(`timeout after ${timeout}ms; terminating duty group\n`));
      if (pid) signalGroup(pid,'SIGTERM');
      setTimeout(() => { if (pid) signalGroup(pid,'SIGKILL'); escalated = true; finish(); },2000);
    },timeout);
    child.once('error', error => { clearTimeout(timer); if (pid) activeGroups.delete(pid); fail(error); });
    child.once('exit', code => {
      closed = true; exitCode = code;
      // An escaped descendant can hold these pipes after the owned leader exits.
      child.stdout.destroy(); child.stderr.destroy();
      finish();
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (refuseUnderT3Code()) process.exit(0);
  let stopping = false;
  for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const groups = [...activeGroups]; groups.forEach(pid => signalGroup(pid,'SIGTERM'));
    setTimeout(() => { groups.forEach(pid => signalGroup(pid,'SIGKILL')); process.exit(signal === 'SIGTERM' ? 143 : 130); },2000);
  });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = process.env.CMUX_RESOURCE_GUARD_CONFIG ?? join(homedir(), '.config/cmuxlayer/resource-guard.json');
  try {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) as GuardConfig : {};
    await runTick({ root, config });
  } catch (error) {
    appendCapped(join(process.env.CMUX_RESOURCE_GUARD_LOG_DIR ?? join(homedir(), 'Library/Logs/cmux-resource-guard'), 'guard.err.log'), Buffer.from(String(error) + '\n'));
    process.exitCode = 1;
  }
}
