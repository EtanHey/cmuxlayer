import { accessSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installGuard, legacyLabels } from '../src/resource-guard-install.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, {recursive:true, force:true})));
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'guard-install-'))); dirs.push(home);
  const root = join(home, 'Cellar/cmuxlayer/0.4.105/libexec');
  mkdirSync(join(root, 'dist'), {recursive:true}); mkdirSync(join(root, '../bin'));
  writeFileSync(join(root, 'dist/resource-guard.js'), '');
  writeFileSync(join(root, '../bin/cmux-resource-guard'), ''); chmodSync(join(root, '../bin/cmux-resource-guard'), 0o755);
  mkdirSync(join(home,'opt')); const opt=join(home,'opt/cmuxlayer'); symlinkSync(join(root,'..'),opt);
  const agents = join(home, 'Library/LaunchAgents'); mkdirSync(agents, {recursive:true});
  const loaded = new Set<string>(), calls: string[] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd.endsWith('/bin/brew')) return opt;
    if (cmd === 'plutil' && args.includes('-convert')) return readFileSync(args.at(-1)!, 'utf8');
    if (args[0] === 'print' && args[1].split('/').length > 2) { if (!loaded.has(args[1].split('/').at(-1)!)) throw new Error('absent'); }
    if (args[0] === 'bootout') loaded.delete(args[1].split('/').at(-1)!);
    if (args[0] === 'bootstrap') loaded.add(args[2].split('/').at(-1)!.replace('.plist',''));
    return '';
  };
  return {home, root, opt, agents, loaded, calls, run};
}
it('dry run is read-only and fresh defaults gate the host duties', () => {
  const f = fixture(); const plist = installGuard(f.root, false, f);
  expect(plist).toContain('/opt/cmuxlayer/bin/cmux-resource-guard'); expect(plist).not.toContain('/Cellar/');
  expect(plist).toContain('com.cmuxlayer.resource-guard'); expect(plist).toContain('<integer>60</integer>');
  expect(f.calls.every(call => !call.includes('launchctl'))).toBe(true);
  expect(existsSync(join(f.home, '.config/cmuxlayer/resource-guard.json'))).toBe(false);
});
it('migrates knobs and execute flag, archives all four old plists, and is idempotent', () => {
  const f = fixture();
  const knobs = [{REAPER_MIN_AGE_SECONDS:'1800'}, {CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS:'3600'},
    {CMUX_MEM_WATCHDOG_THRESHOLD_GB:'12'}, {HEAVY_ML_SWAP_DANGER_PCT:'96'}];
  for (const [index,label] of legacyLabels.entries()) {
    writeFileSync(join(f.agents, label + '.plist'), JSON.stringify({Label:label, ProgramArguments:['/old/reaper', '--execute'], EnvironmentVariables:knobs[index]}));
    f.loaded.add(label);
  }
  const run = (cmd:string,args:string[]) => {
    if (args[0] === 'bootstrap' && args[2].endsWith('com.cmuxlayer.resource-guard.plist')) {
      expect(f.loaded.has(legacyLabels[3])).toBe(false);
    }
    return f.run(cmd,args);
  };
  const success=installGuard(f.root, true, {...f,run});
  expect(success).toContain('watchdog=on guardian=on sampler=on reaper=execute');
  const config = JSON.parse(readFileSync(join(f.home, '.config/cmuxlayer/resource-guard.json'), 'utf8'));
  expect(config.watchdog).toBe(true); expect(config.guardian).toBe(true); expect(config.env.REAPER_DRY_RUN).toBe('0');
  expect(config.env.CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS).toBe('3600');
  expect(config.env.REAPER_MIN_AGE_SECONDS).toBe('1800');
  expect(config.env.CMUX_MEM_WATCHDOG_THRESHOLD_GB).toBe('12');
  expect(config.env.HEAVY_ML_SWAP_DANGER_PCT).toBe('96');
  const guardianStop = f.calls.findIndex(call => call.includes('bootout') && call.endsWith('/' + legacyLabels[3]));
  const guardStart = f.calls.findIndex(call => call.includes('bootstrap') && call.endsWith('com.cmuxlayer.resource-guard.plist'));
  expect(guardianStop).toBeGreaterThanOrEqual(0); expect(guardianStop).toBeLessThan(guardStart);
  for (const label of legacyLabels) expect(existsSync(join(f.agents, label + '.plist'))).toBe(false);
  const original = JSON.stringify(config); installGuard(f.root, true, f);
  expect(JSON.stringify(JSON.parse(readFileSync(join(f.home, '.config/cmuxlayer/resource-guard.json'), 'utf8')))).toBe(original);
});
it('refuses checkouts and refuses unknown bootout failures before archiving', () => {
  const f = fixture(); expect(() => installGuard(f.home, true, f)).toThrow('Cellar');
  const label = legacyLabels[0], file = join(f.agents, label + '.plist');
  writeFileSync(file, JSON.stringify({Label:label})); f.loaded.add(label);
  const run = (cmd:string, args:string[]) => { if (args[0] === 'bootout') throw new Error('denied'); return f.run(cmd,args); };
  expect(() => installGuard(f.root, true, {...f, run})).toThrow('denied'); expect(existsSync(file)).toBe(true);
});
it('rolls back jobs and config if replacement bootstrap fails', () => {
  const f = fixture(), old = legacyLabels[2], file = join(f.agents, old + '.plist');
  writeFileSync(file, JSON.stringify({Label:old, EnvironmentVariables:{CMUX_MEM_WATCHDOG_THRESHOLD_GB:'12'}})); f.loaded.add(old);
  const run = (cmd:string,args:string[]) => {
    if (args[0] === 'bootstrap' && args[2].endsWith('com.cmuxlayer.resource-guard.plist')) throw new Error('bootstrap failed');
    return f.run(cmd,args);
  };
  expect(() => installGuard(f.root,true,{...f,run})).toThrow('previous jobs/config restored');
  expect(f.loaded.has(old)).toBe(true); expect(existsSync(file)).toBe(true);
  expect(existsSync(join(f.home,'.config/cmuxlayer/resource-guard.json'))).toBe(false);
});
it('fails closed for loaded legacy jobs without a recoverable plist', () => {
  const f = fixture(); f.loaded.add(legacyLabels[3]);
  expect(() => installGuard(f.root,true,f)).toThrow('lacks its plist');
  expect(f.calls.some(call => call.includes('bootout') || call.includes('bootstrap'))).toBe(false);
});
it('escapes home paths and preserves an explicit opt-out on migration', () => {
  const f = fixture(), path = join(f.home,'.config/cmuxlayer/resource-guard.json'); mkdirSync(join(f.home,'.config/cmuxlayer'),{recursive:true});
  writeFileSync(path, JSON.stringify({watchdog:false,guardian:false,env:{REAPER_DRY_RUN:'1'}}));
  writeFileSync(join(f.agents,legacyLabels[2] + '.plist'),JSON.stringify({Label:legacyLabels[2]}));
  installGuard(f.root,true,f);
  expect(JSON.parse(readFileSync(path,'utf8')).watchdog).toBe(false);
  const escapedHome = join(f.home,'operator & partner'); mkdirSync(escapedHome);
  expect(installGuard(f.root,false,{...f,home:escapedHome})).toContain('operator &amp; partner');
});
it.skipIf(process.platform !== 'darwin')('renders XML that the real macOS plist parser accepts', async () => {
  const {execFileSync} = await import('node:child_process');
  const f = fixture();
  const old = legacyLabels[0];
  writeFileSync(join(f.agents,old + '.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>' + old + '</string><key>ProgramArguments</key><array><string>reaper</string><string>--execute</string></array></dict></plist>');
  const run = (cmd:string,args:string[]) => cmd.endsWith('/bin/brew') ? f.opt : execFileSync(cmd,args,{encoding:'utf8'});
  const file = join(f.home,'preview.plist'); writeFileSync(file,installGuard(f.root,false,{...f,run}));
  expect(execFileSync('plutil',['-lint',file],{encoding:'utf8'})).toContain('OK');
});

it('removes a partially loaded replacement before restoring old jobs', () => {
  const f=fixture(), old=legacyLabels[0];
  writeFileSync(join(f.agents,old + '.plist'),JSON.stringify({Label:old})); f.loaded.add(old);
  const run=(cmd:string,args:string[])=>{ if(args[0]==='bootstrap' && args[2].endsWith('com.cmuxlayer.resource-guard.plist')) {f.run(cmd,args);throw new Error('partial bootstrap');}return f.run(cmd,args);};
  expect(()=>installGuard(f.root,true,{...f,run})).toThrow('previous jobs/config restored');
  expect([...f.loaded]).toEqual([old]);
});

it('does not replace an invalid existing guard config or enable destructive defaults',()=>{
  const f=fixture(), path=join(f.home,'.config/cmuxlayer/resource-guard.json'); mkdirSync(join(f.home,'.config/cmuxlayer'),{recursive:true});writeFileSync(path,'');
  expect(()=>installGuard(f.root,true,f)).toThrow(); expect(readFileSync(path,'utf8')).toBe('');
  expect(f.calls.some(call=>call.includes('launchctl'))).toBe(false);
});

it('does not reactivate an unloaded host-specific legacy duty',()=>{
  const f=fixture();writeFileSync(join(f.agents,legacyLabels[2] + '.plist'),JSON.stringify({Label:legacyLabels[2]}));
  installGuard(f.root,true,f);
  expect(JSON.parse(readFileSync(join(f.home,'.config/cmuxlayer/resource-guard.json'),'utf8')).watchdog).toBe(false);
});
it.skipIf(process.platform !== 'darwin')('installed preview works through the opt symlink with only system directories on PATH', async()=>{
  const {spawnSync}=await import('node:child_process'), {copyFileSync,symlinkSync}=await import('node:fs'), ts=await import('typescript');
  const f=fixture(), repo=join(import.meta.dirname,'..'); mkdirSync(join(f.root,'scripts'));mkdirSync(join(f.home,'bin'));
  copyFileSync(join(repo,'scripts/install-mcp-reaper.sh'),join(f.root,'scripts/install-mcp-reaper.sh'));
  writeFileSync(join(f.root,'resource-guard-node-path'),process.execPath + '\n'); writeFileSync(join(f.root,'package.json'),'{"type":"module"}');
  writeFileSync(join(f.root,'dist/resource-guard-install.js'),ts.transpileModule(readFileSync(join(repo,'src/resource-guard-install.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
  const brew=join(f.home,'bin/brew');writeFileSync(brew,'#!/bin/sh\nprintf "%s\\n" "$BREW_TEST_PREFIX"\n');chmodSync(brew,0o755);
  const opt=f.opt;
  const result=spawnSync('/bin/bash',[join(opt,'libexec/scripts/install-mcp-reaper.sh'),'--resource-guard','--dry-run'],{env:{...process.env,HOME:f.home,PATH:'/usr/bin:/bin',BREW_TEST_PREFIX:opt},encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0); expect(result.stdout).toContain('<integer>60</integer>'); expect(result.stdout).toContain('/opt/cmuxlayer/bin/'); expect(result.stdout).not.toContain('/Cellar/');
  expect(existsSync(join(f.home,'.config/cmuxlayer/resource-guard.json'))).toBe(false);
});

it('restores moved plists and prior jobs if archival partially fails',()=>{
  const f=fixture(), originalNow=Date.now;
  for(const old of legacyLabels.slice(0,2)){writeFileSync(join(f.agents,old + '.plist'),JSON.stringify({Label:old}));f.loaded.add(old);}
  const archive=join(f.agents,'resource-guard-archive',`1234-${process.pid}`);mkdirSync(join(archive,legacyLabels[1] + '.plist'),{recursive:true});
  Date.now=()=>1234;
  try {expect(()=>installGuard(f.root,true,f)).toThrow('retained plists');} finally {Date.now=originalNow;}
  for(const old of legacyLabels.slice(0,2)){expect(existsSync(join(f.agents,old + '.plist'))).toBe(true);expect(f.loaded.has(old)).toBe(true);}
  expect(f.loaded.has('com.cmuxlayer.resource-guard')).toBe(false);
});

it.each(['throws','no-effect'])('keeps legacy guardians stopped when rollback bootout %s and the new job remains loaded',failure=>{
  const f=fixture(), old=legacyLabels[3], newLabel='com.cmuxlayer.resource-guard', originalNow=Date.now;
  writeFileSync(join(f.agents,old+'.plist'),JSON.stringify({Label:old}));f.loaded.add(old);
  mkdirSync(join(f.agents,'resource-guard-archive',`1234-${process.pid}`,old+'.plist'),{recursive:true});
  const run=(cmd:string,args:string[])=>{
    if(args[0]==='bootout' && args[1].endsWith('/'+newLabel)) {if(failure==='throws')throw new Error('rollback bootout denied');return '';}
    return f.run(cmd,args);
  };
  Date.now=()=>1234;
  try {expect(()=>installGuard(f.root,true,{...f,run})).toThrow('new guard still loaded; legacy jobs left stopped');}finally{Date.now=originalNow;}
  expect([...f.loaded]).toEqual([newLabel]);expect(existsSync(join(f.agents,old+'.plist'))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.home,'.config/cmuxlayer/resource-guard.json'),'utf8')).guardian).toBe(true);
  expect(f.calls.some(call=>call.includes('bootstrap') && call.endsWith(old+'.plist'))).toBe(false);
});
it('reconciles a legacy bootout that takes effect before throwing',()=>{
  const f=fixture(), old=legacyLabels[3];writeFileSync(join(f.agents,old+'.plist'),JSON.stringify({Label:old}));f.loaded.add(old);
  const run=(cmd:string,args:string[])=>{if(args[0]==='bootout' && args[1].endsWith('/'+old)){f.run(cmd,args);throw new Error('bootout took effect');}return f.run(cmd,args);};
  expect(()=>installGuard(f.root,true,{...f,run})).toThrow('previous jobs/config restored');expect([...f.loaded]).toEqual([old]);
});
it('derives missing duty keys from loaded legacy jobs in a partial config',()=>{
  const f=fixture(), config=join(f.home,'.config/cmuxlayer/resource-guard.json');mkdirSync(join(f.home,'.config/cmuxlayer'),{recursive:true});writeFileSync(config,'{"env":{}}');
  for(const old of legacyLabels.slice(2)){writeFileSync(join(f.agents,old+'.plist'),JSON.stringify({Label:old}));f.loaded.add(old);}
  installGuard(f.root,true,f);const migrated=JSON.parse(readFileSync(config,'utf8'));expect(migrated.watchdog).toBe(true);expect(migrated.guardian).toBe(true);
});
it('warns before explicitly opting a loaded legacy duty out',()=>{
  const f=fixture(), old=legacyLabels[2], config=join(f.home,'.config/cmuxlayer/resource-guard.json');mkdirSync(join(f.home,'.config/cmuxlayer'),{recursive:true});writeFileSync(config,'{"watchdog":false}');
  writeFileSync(join(f.agents,old+'.plist'),JSON.stringify({Label:old}));f.loaded.add(old);const warn:string[]=[];
  installGuard(f.root,true,{...f,warn:message=>{expect(f.calls.some(call=>call.includes('bootout'))).toBe(false);warn.push(message);}});
  expect(warn.join(' ')).toContain('watchdog');expect(warn.join(' ')).toContain('disabled');expect(JSON.parse(readFileSync(config,'utf8')).watchdog).toBe(false);
});
it('preserves the legacy sampler default history and guardian sample path',async()=>{
  const f=fixture(), history=join(f.home,'Library/Logs/cmux-ram-sampler');mkdirSync(history,{recursive:true});writeFileSync(join(history,'samples.jsonl'),'existing history');
  for(const old of [legacyLabels[1],legacyLabels[3]]){writeFileSync(join(f.agents,old+'.plist'),JSON.stringify({Label:old}));f.loaded.add(old);}
  installGuard(f.root,true,f);const config=JSON.parse(readFileSync(join(f.home,'.config/cmuxlayer/resource-guard.json'),'utf8'));
  expect(config.env.CMUX_RAM_SAMPLER_LOG_DIR).toBe(history);
  const {runTick}=await import('../src/resource-guard.js');let sample:string|undefined;
  await runTick({root:f.root,home:join(f.home,'state'),config,run:async(_duty,env)=>{sample=env.HEAVY_ML_SAMPLE_FILE;}});
  expect(sample).toBe(join(history,'samples.jsonl'));expect(readFileSync(sample!,'utf8')).toBe('existing history');
});
it('reports the fresh resulting duties and dry-run reaper mode',()=>{
  const f=fixture();expect(installGuard(f.root,true,f)).toContain('watchdog=off guardian=off sampler=on reaper=dry-run');
});
it('restores a prior new guard without activating an unloaded legacy guardian',()=>{
  const f=fixture(), newLabel='com.cmuxlayer.resource-guard', old=legacyLabels[3], target=join(f.agents,newLabel+'.plist');
  writeFileSync(target,'prior guard plist');writeFileSync(join(f.agents,old+'.plist'),JSON.stringify({Label:old}));f.loaded.add(newLabel);
  let attempts=0;const run=(cmd:string,args:string[])=>{if(args[0]==='bootstrap' && args[2]===target && ++attempts===1)throw new Error('replacement failed');return f.run(cmd,args);};
  expect(()=>installGuard(f.root,true,{...f,run})).toThrow('previous jobs/config restored');
  expect([...f.loaded]).toEqual([newLabel]);expect(readFileSync(target,'utf8')).toBe('prior guard plist');
});
