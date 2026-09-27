// #907 round 2: Codex Sol's platform/fault probes (docs.local/lanes/2026-09-27-review-907-platform.test.ts),
// kept as the RED. Two failed at 1780d50f: the ignored-Darwin-flag model and the
// prior-dir close fault.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants, mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mode = vi.hoisted(() => ({ proc: true, ignoreDarwinFlag: false, fakeLinux: false, failOpen: -1, failClose: -1, failStat: false, failRead: false, opens: [] as {path:string,flags:number,fd:number}[], closes: [] as number[] }));
vi.mock('node:fs', async imp => { const a = await imp<typeof import('node:fs')>(); return {...a, existsSync: (p: any) => p === '/proc/self/fd' ? mode.proc : a.existsSync(p)}; });
vi.mock('node:fs/promises', async imp => {
 const a = await imp<typeof import('node:fs/promises')>();
 return {...a, open: async (path: string, flags: number) => {
  if (!mode.fakeLinux) return a.open(path, mode.ignoreDarwinFlag ? flags & ~0x20000000 : flags);
  const fd = mode.opens.length + 100;
  mode.opens.push({path,flags,fd});
  if (fd === mode.failOpen) throw Object.assign(new Error('open fault'), {code:'EACCES'});
  return {fd, close: async () => { mode.closes.push(fd); if(fd === mode.failClose) throw Object.assign(new Error('close fault'),{code:'EIO'}); }, stat: async () => { if(mode.failStat) throw new Error('stat fault'); return {isFile:()=>true,size:3}; }, read: async (buf:Buffer) => { if(mode.failRead) throw new Error('read fault'); buf.write('OK\n'); return {bytesRead:3}; }};
 }};
});
import * as coordination from '../src/coordination-paths.js';
const { readReportTail } = coordination;
// The O_NOFOLLOW_ANY capability probe is cached per process; each fault model needs a fresh one.
const resetProbe = () => (coordination as { __resetNoFollowAnyProbeForTests?: () => void }).__resetNoFollowAnyProbeForTests?.();
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let root='';
afterEach(()=> { resetProbe(); Object.defineProperty(process,'platform',platform); if(root) rmSync(root,{recursive:true,force:true}); root=''; Object.assign(mode,{proc:true,ignoreDarwinFlag:false,fakeLinux:false,failOpen:-1,failClose:-1,failStat:false,failRead:false,opens:[],closes:[]}); });
function linux() { Object.defineProperty(process,'platform',{value:'linux'}); mode.fakeLinux=true; }
describe('review907 platform failure probes',()=> {
 it('Darwin refuses real intermediate and leaf symlinks; real file opens',async()=> {
  root=realpathSync(mkdtempSync(join(tmpdir(),'review907-'))); mkdirSync(join(root,'real')); writeFileSync(join(root,'real','r'),'OK\n'); symlinkSync(join(root,'real'),join(root,'link')); symlinkSync(join(root,'real','r'),join(root,'leaf'));
  expect(await readReportTail(join(root,'real','r'))).toMatchObject({ok:true,text:'OK\n'});
  expect(await readReportTail(join(root,'link','r'))).toMatchObject({ok:false}); expect(await readReportTail(join(root,'leaf'))).toMatchObject({ok:false});
 });
 it('pre-11 ignored flag model: must fail closed (RED)',async()=> {
  root=realpathSync(mkdtempSync(join(tmpdir(),'review907-'))); mkdirSync(join(root,'outside')); writeFileSync(join(root,'outside','r'),'OUTSIDE\n'); symlinkSync(join(root,'outside'),join(root,'link')); mode.ignoreDarwinFlag=true;
  const r=await readReportTail(join(root,'link','r')); console.error('ignored Darwin flag:',JSON.stringify(r)); expect(r.ok).toBe(false);
 });
 it('Linux absent proc refuses before any open',async()=> { linux(); mode.proc=false; expect(await readReportTail('/a/b/r')).toMatchObject({ok:false}); expect(mode.opens).toHaveLength(0); });
 it('non-target platform refuses before any open',async()=> { Object.defineProperty(process,'platform',{value:'win32'}); mode.fakeLinux=true; expect(await readReportTail('/a/b/r')).toMatchObject({ok:false}); expect(mode.opens).toHaveLength(0); });
 it('Linux every component anchored and nofollow; success closes all',async()=> { linux(); expect(await readReportTail('/a/b/r')).toMatchObject({ok:true,text:'OK\n'}); expect(mode.opens.map(v=>v.path)).toEqual(['/','/proc/self/fd/100/a','/proc/self/fd/101/b','/proc/self/fd/102/r']); for(const o of mode.opens.slice(1,3)) expect(o.flags & (constants.O_DIRECTORY|constants.O_NOFOLLOW)).toBe(constants.O_DIRECTORY|constants.O_NOFOLLOW); expect(mode.closes).toEqual([100,101,102,103]); });
 for(const fd of [100,101,102,103]) it('Linux open fault '+fd+' closes held fds',async()=> { linux(); mode.failOpen=fd; expect(await readReportTail('/a/b/r')).toMatchObject({ok:false}); expect(mode.closes).toEqual(Array.from({length:fd-100},(_,i)=>100+i)); });
 for(const type of ['stat','read']) it('Linux '+type+' fault closes all',async()=> { linux(); if(type==='stat')mode.failStat=true; else mode.failRead=true; await expect(readReportTail('/a/b/r')).rejects.toThrow(type+' fault'); expect(mode.closes).toEqual([100,101,102,103]); });
 it('Linux previous-directory close fault must close newly acquired fd (RED)',async()=> { linux(); mode.failClose=100; expect(await readReportTail('/a/b/r')).toMatchObject({ok:false}); console.error('close fault:',JSON.stringify({opens:mode.opens,closes:mode.closes})); expect(mode.closes).toContain(101); });
});
