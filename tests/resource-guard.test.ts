import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendCapped, runTick } from '../src/resource-guard.js';

const dirs: string[] = [];
function scratch() { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'resource-guard-'))); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe('resource guard', () => {
  it('dispatches every duty on its cadence across separate invocations', async () => {
    const home = scratch(), calls: string[] = [];
    const options = { home, root: '/keg/libexec', config: { watchdog: true, guardian: true },
      run: async (name: string) => { calls.push(name); } };
    for (let tick = 1; tick <= 30; tick++) {
      calls.length = 0;
      await runTick(options);
      expect(calls).toEqual(['guardian', 'watchdog', ...(tick % 30 === 0 ? ['sampler'] : []), ...(tick % 5 === 0 ? ['reaper'] : [])]);
    }
  });
  it('fresh installs enable sampler and dry-run reaper; host duties require opt-in', async () => {
    const calls: string[] = [], envs: Record<string, string | undefined>[] = [];
    const home = scratch();
    writeFileSync(join(home, 'tick'), '29');
    await runTick({ home, root: '/keg/libexec', run: async (name, env) => { calls.push(name); envs.push(env); } });
    expect(calls).toEqual(['sampler', 'reaper']);
    expect(envs.every(env => env.REAPER_DRY_RUN === '1')).toBe(true);
  });
  it('streams huge output through a strict two-file cap', () => {
    const file = join(scratch(), 'guard.log');
    for (let i = 0; i < 20; i++) appendCapped(file, Buffer.alloc(70, i), 100);
    expect(readdirSync(join(file, '..')).sort()).toEqual(['guard.log', 'guard.log.1']);
    expect(readFileSync(file).length).toBeLessThanOrEqual(100);
    expect(readFileSync(file + '.1').length).toBeLessThanOrEqual(100);
  });
  it('continues the other duties after a failure and allows the next tick', async () => {
    const home = scratch(), calls: string[] = [];
    const options = { home, root: '/keg/libexec', config: { watchdog: true, guardian: true },
      run: async (name: string) => { calls.push(name); if (name === 'watchdog') throw new Error('broken'); } };
    await expect(runTick(options)).rejects.toThrow('watchdog');
    await expect(runTick(options)).rejects.toThrow('watchdog');
    expect(calls).toEqual(['guardian', 'watchdog', 'guardian', 'watchdog']);
  });
});

// Compile the shipped native launcher and make it serve a real dispatcher request.
it('ships a named executable, all four real duties, and an idempotent jq formula fragment', async () => {
  const { spawnSync } = await import('node:child_process');
  const { cpSync, mkdirSync } = await import('node:fs');
  const root = join(import.meta.dirname, '..'), keg = scratch(), home = scratch();
  const formula = join(keg, 'cmuxlayer.rb');
  writeFileSync(formula, 'class Cmuxlayer\n  def install\n    libexec.install "dist", "node_modules", "package.json"\n  end\nend\n');
  expect(spawnSync(process.execPath, [join(root, 'scripts/package-resource-guard.mjs'), formula]).status).toBe(0);
  const firstPackaging = readFileSync(formula, 'utf8');
  expect(spawnSync(process.execPath, [join(root, 'scripts/package-resource-guard.mjs'), formula]).status).toBe(0);
  expect(readFileSync(formula, 'utf8')).toBe(firstPackaging);
  const packaged = readFileSync(formula, 'utf8');
  expect(packaged.match(/depends_on "jq"/g)).toHaveLength(1);
  expect(packaged.match(/BEGIN cmux-resource-guard/g)).toHaveLength(1);
  expect(packaged.indexOf('system ENV.cc')).toBeLessThan(packaged.indexOf('libexec.install "launchd"'));
  cpSync(join(root, 'launchd'), join(keg, 'launchd'), { recursive: true });
  mkdirSync(join(keg, 'dist'));
  const ts = await import('typescript');
  for (const name of ['resource-guard', 'mcp-reaper']) {
    writeFileSync(join(keg, 'dist', name + '.js'), ts.transpileModule(readFileSync(join(root, 'src', name + '.ts'), 'utf8'),
      {compilerOptions:{module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022}}).outputText);
  }
  mkdirSync(join(keg, 'dist/util'));
  writeFileSync(join(keg, 'dist/util/pid-alive.js'), ts.transpileModule(readFileSync(join(root, 'src/util/pid-alive.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022}}).outputText);
  writeFileSync(join(keg, 'package.json'), '{"type":"module"}');
  const binary = join(keg, 'cmux-resource-guard');
  const built = spawnSync('cc', ['-Wall', '-Wextra', '-Werror', `-DGUARD_NODE="${process.execPath}"`, `-DGUARD_PATH="${process.env.PATH}"`, `-DGUARD_ENTRY="${join(keg, 'dist/resource-guard.js')}"`, join(root, 'launchd/resource-guard/cmux-resource-guard.c'), '-o', binary], {encoding:'utf8'});
  expect(built.status, built.stderr).toBe(0);
  const state = join(home, '.local/state/cmux-resource-guard'); mkdirSync(state, {recursive:true}); writeFileSync(join(state, 'tick'), '29');
  const empty = join(home, 'empty'); writeFileSync(empty, '');
  const pressure = join(home, 'pressure'); writeFileSync(pressure, 'System-wide memory free percentage: 90%\n');
  const vm = join(home, 'vm'); writeFileSync(vm, 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 100.\nPages occupied by compressor: 0.\n');
  const knobs = {REAPER_DRY_RUN:'1', HEAVY_ML_CLX_CLI:'', HEAVY_ML_DANGER_STATE_DIR:join(home,'guardian-state'), CMUX_MEM_WATCHDOG_THRESHOLD_GB:'invalid', HEAVY_ML_PS_FIXTURE:empty, HEAVY_ML_MEMPRESSURE_FIXTURE:pressure,
    HEAVY_ML_VMSTAT_FIXTURE:vm, HEAVY_ML_GUARD_ENABLE_KILL:'0', CMUX_RAM_SAMPLER_VMSTAT_FIXTURE:vm,
    CMUX_RAM_SAMPLER_STABLE_PATH:'/fixture/no-stable', CMUX_RAM_SAMPLER_NIGHTLY_PATH:'/fixture/no-nightly'};
  const config = join(home, 'config.json'); writeFileSync(config, JSON.stringify({watchdog:true, guardian:true, env:knobs}));
  const request = spawnSync(binary, [], {env:{...process.env, HOME:home, CMUX_RESOURCE_GUARD_CONFIG:config}, encoding:'utf8'});
  expect(request.status, request.stderr).toBe(0);
  const logs = join(home, 'Library/Logs/cmux-resource-guard');
  expect(readFileSync(join(logs, 'watchdog.err.log'), 'utf8')).toContain('refusing to run');
  expect(JSON.parse(readFileSync(join(logs, 'guardian.out.log'), 'utf8')).heavy_ml_count).toBe(0);
  expect(readFileSync(join(logs, 'sampler.err.log'), 'utf8')).toContain('not running');
  expect(readFileSync(join(logs, 'reaper.out.log'), 'utf8')).toMatch(/No reapable|DRY_RUN/);
  expect(readFileSync(join(state, 'tick'), 'utf8')).toBe('0');
}, 60_000);
it('native lock prevents overlap and recovers after process termination', async () => {
  const {spawn, spawnSync} = await import('node:child_process');
  const {once} = await import('node:events');
  const dir = scratch(), entry = join(dir,'entry.mjs'), binary = join(dir,'cmux-resource-guard');
  writeFileSync(entry, 'console.log("ready"); setInterval(()=>{},1000);');
  const result = spawnSync('cc', [`-DGUARD_NODE="${process.execPath}"`, `-DGUARD_PATH="${process.env.PATH}"`, `-DGUARD_ENTRY="${entry}"`, join(import.meta.dirname,'../launchd/resource-guard/cmux-resource-guard.c'), '-o',binary],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  const start = () => spawn(binary,[],{env:{...process.env,HOME:dir},stdio:['ignore','pipe','pipe']});
  const first = start(); await once(first.stdout,'data');
  try { const second = spawnSync(binary,[],{env:{...process.env,HOME:dir},encoding:'utf8',timeout:2000}); expect(second.status).toBe(0); expect(second.stdout).toBe(''); expect(readFileSync(join(dir,'Library/Logs/cmux-resource-guard/guard.lock.log'),'utf8')).toContain('lock busy'); }
  finally { first.kill('SIGTERM'); await once(first,'close'); }
  const third = start();
  try { const [out] = await once(third.stdout,'data'); expect(String(out)).toContain('ready'); }
  finally { third.kill('SIGTERM'); await once(third,'close'); }
}, 60_000);

it('rejects malformed configuration before invoking a host duty', async () => {
  let invoked = false;
  await expect(runTick({root:'/keg',home:scratch(),config:{watchdog:true,env:[] as never},run:async()=>{invoked=true;}})).rejects.toThrow('invalid');
  expect(invoked).toBe(false);
});

it('caps JSONL at complete row boundaries without archive duplication', async () => {
  const home = scratch(), file = join(home, 'samples.jsonl');
  writeFileSync(file, Array.from({length:30000},(_,i)=>JSON.stringify({i,payload:'x'.repeat(200)})).join('\n') + '\n');
  await runTick({root:'/keg',home,config:{env:{CMUX_RAM_SAMPLER_SAMPLE_FILE:file}},run:async()=>{}});
  const current = readFileSync(file,'utf8'), archive = readFileSync(file + '.1','utf8');
  expect(Buffer.byteLength(current)).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(Buffer.byteLength(archive)).toBeLessThanOrEqual(5 * 1024 * 1024);
  const ids = (archive + current).trim().split('\n').map(line=>JSON.parse(line).i);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.at(-1)).toBe(29999);
});

it('times out an uncooperative duty group while guardian runs on the same and next tick', async()=>{
  const {mkdirSync}=await import('node:fs'); const root=scratch(), home=scratch();
  mkdirSync(join(root,'launchd/resource-guard'),{recursive:true});
  writeFileSync(join(root,'launchd/resource-guard/heavy-ml-guardian.sh'),'echo guardian-ran\n');
  writeFileSync(join(root,'launchd/resource-guard/cmux-memory-watchdog.sh'),'trap "" TERM\nsleep 30 &\necho $! > "$CHILD_PID_FILE"\nwait\n');
  const options={root,home,config:{watchdog:true,guardian:true,env:{CMUX_RESOURCE_GUARD_DUTY_TIMEOUT_MS:'100',CHILD_PID_FILE:join(home,'child')}}};
  for(let tick=0;tick<2;tick++) {
    await expect(runTick(options)).rejects.toThrow('timeout');
    const pid=Number(readFileSync(join(home,'child'),'utf8'));
    const {spawnSync}=await import('node:child_process');
    const status=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).stdout.trim();
    expect(status === '' || status.startsWith('Z')).toBe(true);
  }
  expect(readFileSync(join(home,'logs/guardian.out.log'),'utf8').trim().split('\n')).toEqual(['guardian-ran','guardian-ran']);
  expect(readFileSync(join(home,'logs/watchdog.err.log'),'utf8')).toContain('timeout');
}, 60_000);
it('recovers an invalid tick and leaves disabled watchdog snapshot directories untouched',async()=>{
  const {mkdirSync}=await import('node:fs'); const home=scratch(), snapshots=join(home,'shared');mkdirSync(snapshots);
  for(let i=0;i<4;i++)writeFileSync(join(snapshots,i + '.log'),'keep');writeFileSync(join(home,'tick'),'99');
  const calls:string[]=[];await runTick({root:'/keg',home,config:{guardian:true,env:{CMUX_MEM_WATCHDOG_LOG_DIR:snapshots}},run:async name=>{calls.push(name);}});
  expect(calls).toEqual(['guardian']);expect(readFileSync(join(home,'tick'),'utf8')).toBe('1');expect(readdirSync(snapshots)).toHaveLength(4);
  expect(readFileSync(join(home,'logs/guard.err.log'),'utf8')).toContain('reset');
});
it('caps the archive of a corrupted file containing no newline',async()=>{
  const home=scratch(), file=join(home,'samples');writeFileSync(file,Buffer.alloc(12 * 1024 * 1024,65));
  await runTick({root:'/keg',home,config:{env:{CMUX_RAM_SAMPLER_SAMPLE_FILE:file}},run:async()=>{}});
  expect(readFileSync(file + '.1').length).toBeLessThanOrEqual(5 * 1024 * 1024);
});
it('repeated CLI shutdown signals terminate detached duty descendants',async()=>{
  const {mkdirSync,existsSync}=await import('node:fs'), {spawn,spawnSync}=await import('node:child_process'), {once}=await import('node:events'), ts=await import('typescript');
  const root=scratch(), home=scratch();mkdirSync(join(root,'dist'));mkdirSync(join(root,'launchd/resource-guard'),{recursive:true});
  writeFileSync(join(root,'package.json'),'{"type":"module"}');
  const entry=join(root,'dist/resource-guard.js');writeFileSync(entry,ts.transpileModule(readFileSync(join(import.meta.dirname,'../src/resource-guard.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
  const pids=join(home,'pids');writeFileSync(join(root,'launchd/resource-guard/heavy-ml-guardian.sh'),'trap "" TERM\nsleep 5 &\necho $$ $! > "$PID_FILE"\nwait\n');
  const config=join(home,'config');writeFileSync(config,JSON.stringify({guardian:true,env:{PID_FILE:pids}}));
  const child=spawn(process.execPath,[entry],{env:{...process.env,HOME:home,CMUX_RESOURCE_GUARD_CONFIG:config},stdio:'ignore'}), closed=once(child,'close');
  let owned:number[]=[], complete=false;
  try {
    for(let i=0;i<100 && !existsSync(pids);i++)await new Promise(r=>setTimeout(r,20));
    owned=readFileSync(pids,'utf8').trim().split(' ').map(Number);child.kill('SIGTERM');await new Promise(r=>setTimeout(r,50));child.kill('SIGTERM');await closed;
    for(const pid of owned){const state=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).stdout.trim();expect(state === '' || state.startsWith('Z')).toBe(true);}
    complete=true;
  } finally {
    if (!complete) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      // The fixture expires itself even if a broken dispatcher orphaned it.
      // Do not signal an orphan after it leaves this test's ancestry.
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}, 60_000);

it('bounds a tick when a setsid descendant retains duty pipes', async () => {
  const {mkdirSync, existsSync} = await import('node:fs');
  const {spawnSync} = await import('node:child_process');
  const root = scratch(), home = scratch(), escaped = join(home,'escaped');
  mkdirSync(join(root,'launchd/resource-guard'),{recursive:true});
  const guardian = join(root,'launchd/resource-guard/heavy-ml-guardian.sh');
  writeFileSync(guardian, `trap "" TERM\necho guardian-ran\n/usr/bin/perl -MPOSIX=setsid -e 'my $pid=fork(); defined($pid) or die "fork"; if (!$pid) { setsid() >= 0 or die "setsid"; open my $fh, ">", $ENV{ESCAPED_PID_FILE} or die $!; print $fh $$; close $fh; sleep 8; exit 0; } sleep 30;'\n`);
  const options = {root,home,config:{guardian:true,env:{CMUX_RESOURCE_GUARD_DUTY_TIMEOUT_MS:'500',ESCAPED_PID_FILE:escaped}}};
  const started = Date.now();
  try {
    await expect(runTick(options)).rejects.toThrow('timeout');
    expect(Date.now() - started).toBeLessThan(4500);
    const pid = Number(readFileSync(escaped,'utf8'));
    expect(spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).stdout.trim()).not.toMatch(/^$|^Z/);
    writeFileSync(guardian,'echo guardian-ran\n');
    await runTick(options);
    expect(readFileSync(join(home,'logs/guardian.out.log'),'utf8').trim().split('\n')).toEqual(['guardian-ran','guardian-ran']);
  } finally {
    // The escaped fixture expires itself; never signal an orphan after custody is lost.
    while (Date.now() - started < 9500) {
      if (existsSync(escaped)) {
        const state = spawnSync('ps',['-p',readFileSync(escaped,'utf8'),'-o','stat='],{encoding:'utf8'}).stdout.trim();
        if (state === '' || state.startsWith('Z')) break;
      }
      await new Promise(resolve => setTimeout(resolve,50));
    }
  }
}, 60_000);

it('kills surviving group members after the duty leader exits on TERM', async () => {
  const {mkdirSync, existsSync} = await import('node:fs');
  const {spawn, spawnSync} = await import('node:child_process');
  const {once} = await import('node:events'), ts = await import('typescript');
  const root = scratch(), home = scratch(), leaderFile = join(home,'leader'), memberFile = join(home,'member');
  mkdirSync(join(root,'dist')); mkdirSync(join(root,'launchd/resource-guard'),{recursive:true});
  writeFileSync(join(root,'package.json'),'{"type":"module"}');
  const entry = join(root,'dist/resource-guard.js');
  writeFileSync(entry,ts.transpileModule(readFileSync(join(import.meta.dirname,'../src/resource-guard.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
  writeFileSync(join(root,'launchd/resource-guard/heavy-ml-guardian.sh'),`trap "exit 0" TERM\necho $$ > "$LEADER_PID_FILE"\n/usr/bin/perl -e '$SIG{TERM}="IGNORE"; open my $fh, ">", $ENV{MEMBER_PID_FILE} or die $!; print $fh $$; close $fh; sleep 8;' &\nwhile :; do sleep 1; done\n`);
  const config = join(home,'config');
  writeFileSync(config,JSON.stringify({guardian:true,env:{CMUX_RESOURCE_GUARD_DUTY_TIMEOUT_MS:'500',LEADER_PID_FILE:leaderFile,MEMBER_PID_FILE:memberFile}}));
  const started = Date.now(), child = spawn(process.execPath,[entry],{env:{...process.env,HOME:home,CMUX_RESOURCE_GUARD_CONFIG:config},stdio:'ignore'}), closed = once(child,'close');
  const state = (pid:string) => spawnSync('ps',['-p',pid,'-o','stat='],{encoding:'utf8'}).stdout.trim();
  try {
    for(let i=0;i<100 && !existsSync(memberFile);i++) await new Promise(resolve=>setTimeout(resolve,20));
    await new Promise(resolve=>setTimeout(resolve,900));
    expect(state(readFileSync(leaderFile,'utf8').trim())).toMatch(/^$|^Z/);
    expect(state(readFileSync(memberFile,'utf8').trim())).not.toMatch(/^$|^Z/);
    const [code] = await closed; expect(code).toBe(1);
    expect(state(readFileSync(memberFile,'utf8').trim())).toMatch(/^$|^Z/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    // The bounded fixture expires itself if a broken dispatcher leaves it behind.
    while(Date.now()-started < 9500) {
      if(existsSync(memberFile) && /^$|^Z/.test(state(readFileSync(memberFile,'utf8').trim()))) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
}, 60_000);
