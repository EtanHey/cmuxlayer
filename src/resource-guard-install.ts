import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const legacyLabels = ['com.cmuxlayer.mcp-reaper', 'com.golems.cmux-ram-sampler',
  'com.golems.cmux-memory-watchdog', 'com.golems.heavy-ml-guardian'];
const label = 'com.cmuxlayer.resource-guard';
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[char]!));
type Config = {watchdog?: boolean; guardian?: boolean; env?: Record<string, string>};
type Run = (cmd: string, args: string[]) => string;
const exec: Run = (cmd, args) => execFileSync(cmd, args, {encoding:'utf8', stdio:['ignore','pipe','pipe']});
function atomic(file: string, text: string): void {
  mkdirSync(dirname(file), {recursive:true}); const staged = file + '.' + process.pid;
  writeFileSync(staged, text, {mode:0o600}); renameSync(staged, file);
}

export function installGuard(inputRoot: string, install: boolean, options: {home?: string; run?: Run; warn?: (message:string)=>void} = {}): string {
  const root = realpathSync(inputRoot), home = options.home ?? homedir(), run = options.run ?? exec;
  if (!/\/Cellar\/cmuxlayer\/[^/]+\/libexec$/.test(root)) throw new Error('resource guard requires an installed Homebrew Cellar keg');
  const prefix = run(resolve(root,'../../../../bin/brew'),['--prefix','cmuxlayer']).trim();
  if (!prefix.endsWith('/opt/cmuxlayer') || realpathSync(prefix) !== dirname(root)) throw new Error('resource guard must use the active installed Homebrew keg');
  const binary = join(prefix, 'bin/cmux-resource-guard'); accessSync(binary, constants.X_OK);
  accessSync(join(root, 'dist/resource-guard.js'));
  const agents = join(home, 'Library/LaunchAgents'), target = join(agents, label + '.plist');
  const configPath = join(home, '.config/cmuxlayer/resource-guard.json');
  const originalConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const config: Config = originalConfig !== undefined ? JSON.parse(originalConfig) : {env:{}};
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      config.watchdog !== undefined && typeof config.watchdog !== 'boolean' ||
      config.guardian !== undefined && typeof config.guardian !== 'boolean' ||
      config.env && (typeof config.env !== 'object' || Array.isArray(config.env) || Object.values(config.env).some(v => typeof v !== 'string'))) throw new Error('invalid guard config');
  const env: Record<string,string> = {};
  const legacy = legacyLabels.filter(old => existsSync(join(agents, old + '.plist')));
  const prefixes = ['REAPER_', 'CMUX_RAM_SAMPLER_', 'CMUX_MEM_WATCHDOG_', 'HEAVY_ML_'];
  for (const old of legacy) {
    const data = JSON.parse(run('plutil', ['-convert','json','-o','-',join(agents, old + '.plist')]));
    if (data.Label !== old) throw new Error(`legacy plist label mismatch: ${old}`);
    const prefix = prefixes[legacyLabels.indexOf(old)];
    for (const [key,value] of Object.entries(data.EnvironmentVariables ?? {})) {
      if (key.startsWith(prefix) || key.startsWith('RAM_SEAT_')) {
        if (typeof value !== 'string') throw new Error(`invalid legacy env: ${key}`);
        env[key] = value;
      }
    }
    if (old === legacyLabels[0] && data.ProgramArguments?.includes('--execute')) env.REAPER_DRY_RUN = '0';
    if (old === legacyLabels[1]) env.CMUX_RAM_SAMPLER_LOG_DIR ??= join(home,'Library/Logs/cmux-ram-sampler');
  }
  config.env = {...env, ...config.env}; // Explicit existing guard config wins on reruns.
  config.env.REAPER_DRY_RUN ??= '1';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${xml(binary)}</string></array>\n<key>EnvironmentVariables</key><dict><key>CMUX_RESOURCE_GUARD_CONFIG</key><string>${xml(configPath)}</string></dict>\n<key>StartInterval</key><integer>60</integer>\n</dict></plist>\n`;
  if (!install) return plist;
  const domain = `gui/${process.getuid!()}`;
  run('launchctl', ['print', domain]); // Refuse a missing/inaccessible GUI domain.
  const loaded = (name: string) => { try { run('launchctl',['print',`${domain}/${name}`]); return true; } catch { return false; } };
  for (const old of legacyLabels) if (!legacy.includes(old) && loaded(old)) throw new Error(`loaded legacy job lacks its plist: ${old}`);
  const originallyLoaded = legacy.filter(loaded);
  for (const [key,old] of [['watchdog',legacyLabels[2]],['guardian',legacyLabels[3]]] as const) {
    if (config[key] === undefined) config[key] = originallyLoaded.includes(old);
    else if (config[key] === false && originallyLoaded.includes(old))
      (options.warn ?? console.warn)(`${key} disabled by explicit false despite loaded legacy duty ${old}`);
  }
  mkdirSync(agents, {recursive:true});
  const staged = target + '.staged'; writeFileSync(staged, plist, {mode:0o600});
  try { run('plutil',['-lint',staged]); } finally { rmSync(staged); }
  const originalPlist = existsSync(target) ? readFileSync(target,'utf8') : undefined;
  const previouslyLoaded = loaded(label);
  let newStarted = false;
  const moved: [string,string][] = [];
  try {
    for (const name of [...legacy, label]) {
      if (loaded(name)) {
        run('launchctl',['bootout',`${domain}/${name}`]);
        if (loaded(name)) throw new Error(`job still loaded after bootout: ${name}`);
      }
    }
    atomic(configPath, JSON.stringify(config,null,2) + '\n'); atomic(target, plist);
    run('launchctl',['bootstrap',domain,target]); newStarted = true;
    if (!loaded(label)) throw new Error('resource guard not loaded after bootstrap');
    if (legacy.length) {
      const archive = join(agents, 'resource-guard-archive', `${Date.now()}-${process.pid}`); mkdirSync(archive,{recursive:true});
      for (const old of legacy) {
        const from = join(agents,old + '.plist'), to = join(archive,old + '.plist');
        try { renameSync(from,to); moved.push([from,to]); }
        catch (error) { throw new Error(`archive failed: ${String(error)}; retained plists: ${legacy.map(name=>join(agents,name + '.plist')).filter(existsSync).join(', ')}`); }
      }
    }
  } catch (error) {
    const rollback: string[] = [];
    const restore = (operation: () => void) => { try { operation(); } catch (e) { rollback.push(String(e)); } };
    for (const [from,to] of moved.reverse()) restore(() => renameSync(to,from));
    if (newStarted || loaded(label)) restore(() => { run('launchctl',['bootout',`${domain}/${label}`]); });
    if (loaded(label)) {
      rollback.push('new guard still loaded; legacy jobs left stopped; replacement config/plist retained');
      throw new Error(`${String(error)}; rollback failed: ${rollback.join('; ')}`);
    }
    restore(() => originalConfig === undefined ? rmSync(configPath,{force:true}) : atomic(configPath,originalConfig));
    restore(() => originalPlist === undefined ? rmSync(target,{force:true}) : atomic(target,originalPlist));
    for (const name of originallyLoaded) {
      if (!loaded(name)) restore(() => { run('launchctl',['bootstrap',domain,join(agents,name + '.plist')]); });
    }
    if (previouslyLoaded && originalPlist && originallyLoaded.length === 0)
      restore(() => { run('launchctl',['bootstrap',domain,target]); });
    throw new Error(`${String(error)}${rollback.length ? '; rollback failed: ' + rollback.join('; ') : '; previous jobs/config restored'}`);
  }
  const reaper = ['0','false','no'].includes(config.env.REAPER_DRY_RUN.trim().toLowerCase()) ? 'execute' : 'dry-run';
  return `installed ${label}; watchdog=${config.watchdog ? 'on' : 'off'} guardian=${config.guardian ? 'on' : 'off'} sampler=on reaper=${reaper}; legacy plists archived`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--dry-run';
  if (!['--dry-run','--install'].includes(mode)) throw new Error('usage: install-mcp-reaper.sh --resource-guard [--dry-run|--install]');
  const plist = installGuard(resolve(dirname(fileURLToPath(import.meta.url)), '..'), mode === '--install');
  console.log(plist);
}
