// Private first-case transport: unchanged product proxy with no spawn/reexec route.
import * as fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateConfig,windowBudget,processIdentity,sameProcess} from './original-roots-first-case.mjs';
const self=fileURLToPath(import.meta.url);
export function requirePrivateDaemon(c, expected, current, socket) {
 if (!sameProcess(expected,current) || !socket?.isSocket() || socket.uid!==501) throw Error('private daemon identity/socket unavailable; no proxy launch');
 validateConfig(c);
}
export function ancestry(c,pid,query) {
 const rows=[],seen=new Set();
 for(let i=0;i<128;i++) {
  if(seen.has(pid))throw Error('ancestry cycle'); seen.add(pid);
  const row=query(pid,windowBudget(c,1,1000)); rows.push(row);
  if(row.pid!==pid || row.uid!==501)throw Error('foreign/unknown ancestor');
  if(pid===c.appProcess.pid) {if(!sameProcess(c.appProcess,row))throw Error('GUI identity changed');return rows;}
  if(!Number.isSafeInteger(row.ppid) || row.ppid<=1)throw Error('ancestry does not reach existing GUI'); pid=row.ppid;
 }
 throw Error('ancestry depth exceeded');
}
export const queryProcess = (pid,timeout) => {
 const field=name=>execFileSync('/bin/ps',['-p',String(pid),'-o',name+'='],{encoding:'utf8',timeout}).trim();
 return {pid,ppid:Number(field('ppid')),uid:Number(field('uid')),start:field('lstart'),executable:field('comm'),argv:field('args')};
};
export async function strictProxy(c,expected,deps) {
 requirePrivateDaemon(c,expected,deps.identity(expected.pid),deps.socket());
 const chains={proxy:ancestry(c,process.pid,deps.query),daemon:ancestry(c,expected.pid,deps.query)};
 deps.record?.(chains);
 windowBudget(c);
 const proxy=await deps.start({socketPath:join(c.root,'d.sock'),env:process.env,input:process.stdin,output:process.stdout,
  detectStaleBuild:()=>null,installedDaemonScriptPath:()=>null,installedEntryScriptPath:()=>null});
 process.stdin.once('end',()=>void proxy.stop()); process.stdin.once('close',()=>void proxy.stop());
 return proxy;
}
if(process.argv[1] && resolve(process.argv[1])===self) {
 const root=process.env.CMUXLAYER_FIRSTCASE_ROOT, c=JSON.parse(fs.readFileSync(join(root,'config.json'),'utf8'));
 validateConfig(c); if(process.getuid()!==501 || createHash('sha256').update(fs.readFileSync(self)).digest('hex')!==c.proxyRunnerSha256)throw Error('proxy bytes/account changed');
 const {runProxy}=await import(pathToFileURL(join(c.candidate,'dist/proxy.js')));
 await strictProxy(c,JSON.parse(fs.readFileSync(join(root,'daemon-identity.json'),'utf8')),{identity:processIdentity,socket:()=>fs.lstatSync(join(root,'d.sock')),query:queryProcess,start:runProxy,
  record:chains=>fs.writeFileSync(join(root,'strict-proxy-ancestry.json'),JSON.stringify(chains,null,2)+'\n',{flag:'wx',mode:0o600})});
}
