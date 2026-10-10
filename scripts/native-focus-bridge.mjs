// Private FIFO descriptors: one bound gate/boot peer, closed command set, no listener.
import * as fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {dirname,join} from 'node:path';
import {sameProcess} from './original-roots-first-case.mjs';
import {ancestry,queryProcess} from './original-roots-first-case.proxy.mjs';
const check=(ok,why)=>{if(!ok)throw Error(why);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fields=['dev','ino','uid'];
export function validateBridgeEnvelope(row,b,sequence,now=Date.now()) {
 check(row?.nonce===b.nonce&&row.session===b.session&&row.runId===b.runId&&row.dispatchId===b.dispatchId&&row.threadId===b.threadId&&row.sequence===sequence,'bridge provenance/sequence mismatch');
 check(row.deadlineUTC===b.deadlineUTC&&now<Date.parse(b.deadlineUTC)&&now-Date.parse(row.sentUTC)>=0&&now-Date.parse(row.sentUTC)<=30000,'bridge expired/stale frame');
 check(['before-create','before-runner','after-runner','result'].includes(row.phase),'unsupported bridge command');
 return row;
}
function endpoint(path,expected) {
 const s=fs.lstatSync(path);
 check(s.isFIFO()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===501&&(s.mode&0o777)===0o600&&fs.realpathSync(path)===path&&fields.every(k=>s[k]===expected[k]),'private FIFO identity changed');
 return s;
}
export class Frames {
 constructor(path,identity,deadline,signal){this.signal=signal;endpoint(path,identity);this.path=path;this.identity=identity;this.deadline=deadline;this.fd=fs.openSync(path,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(this.fd);check(fields.every(k=>s[k]===identity[k]),'FIFO descriptor substituted');}catch(error){this.close();throw error;}this.buffer='';this.decoder=new StringDecoder('utf8');}
 budget(){check(!this.signal?.aborted,'bridge cancelled; uncertainty retained');endpoint(this.path,this.identity);check(Date.now()<this.deadline,'bridge absolute deadline');}
 async write(row){const bytes=Buffer.from(JSON.stringify(row)+'\n');check(bytes.length<=65536,'bridge output bound');let offset=0;while(offset<bytes.length){this.budget();try{offset+=fs.writeSync(this.fd,bytes,offset,bytes.length-offset);}catch(e){if(e.code!=='EAGAIN')throw e;await pause(10);}}}
 async read(){while(true){this.budget();const n=this.buffer.indexOf('\n');if(n>=0){const row=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);return JSON.parse(row);}const bytes=Buffer.alloc(4096);try{const n=fs.readSync(this.fd,bytes,0,bytes.length,null);if(n)this.buffer+=this.decoder.write(bytes.subarray(0,n));}catch(e){if(e.code!=='EAGAIN')throw e;}check(Buffer.byteLength(this.buffer)<=65536,'bridge input bound');await pause(10);}}
 close(){if(this.fd!==undefined){fs.closeSync(this.fd);this.fd=undefined;}}
}
export function createBridge(episode) {
 episode.alive();const c=episode.c,b={nonce:randomUUID(),session:episode.session,runId:c.runId,dispatchId:c.dispatchId,threadId:c.threadId,deadlineUTC:c.deadlineUTC,helperIdentity:episode.baseline,helperSHA256:c.helperSHA256,controllerIdentity:episode.controller};
 for(const side of ['request','response']){const path=join(c.receiptDir,side+'.fifo');execFileSync('/usr/bin/mkfifo',['-m','600',path],{timeout:1000});const s=fs.lstatSync(path);b[side]={path,identity:Object.fromEntries(fields.map(k=>[k,s[k]]))};endpoint(path,b[side].identity);}
 episode.record('bridge',b);return b;
}
export class BridgeClient {
 constructor(b,c){this.b=b;this.c=c;this.sequence=0;check(sameProcess(b.controllerIdentity,queryProcess(b.controllerIdentity.pid,1000))&&sameProcess(b.helperIdentity,queryProcess(b.helperIdentity.pid,1000)),'live bridge controller/helper required');this.request=new Frames(b.request.path,b.request.identity,Date.parse(b.deadlineUTC));try{this.response=new Frames(b.response.path,b.response.identity,Date.parse(b.deadlineUTC));}catch(error){this.request.close();throw error;}}
 async call(phase,detail={}) {
  check(!this.failed,'bridge uncertainty retained; no further frame');
  try {
  const b=this.b,sequence=++this.sequence,peer=queryProcess(process.pid,1000);
  ancestry(this.c,process.pid,queryProcess);
  const end=Math.min(Date.parse(b.deadlineUTC),Date.now()+30000);this.request.deadline=end;this.response.deadline=end;
  await this.request.write({...b,request:undefined,response:undefined,phase,sequence,sentUTC:new Date().toISOString(),peer,detail});
  const row=await this.response.read();validateBridgeEnvelope(row,b,sequence);check(row.phase===phase&&row.status==='OBSERVED','live checkpoint unavailable: '+(row.error??row.status));
  check(sameProcess(b.controllerIdentity,queryProcess(b.controllerIdentity.pid,1000))&&sameProcess(b.helperIdentity,queryProcess(b.helperIdentity.pid,1000)),'bridge identity lost after reply');return row;
  }catch(error){this.failed=true;throw error;}
 }
 close(){this.request.close();this.response.close();}
}
export async function serveBridge(b,c,gateIdentity,handle,record,{signal,query=queryProcess,lineage=ancestry}={}) {
 const request=new Frames(b.request.path,b.request.identity,Date.parse(b.deadlineUTC),signal);let response;try{response=new Frames(b.response.path,b.response.identity,Date.parse(b.deadlineUTC),signal);}catch(error){request.close();throw error;}
 let sequence=0,peer;
 try{let index=0;while(true){const phase=['before-create','before-runner','after-runner','result'][index];
  const row=await request.read();record('bridge-request-'+(++sequence),row);validateBridgeEnvelope(row,b,sequence);check(row.phase===phase||row.phase==='result','bridge phase order changed');
  const current=query(row.peer.pid,1000);check(sameProcess(row.peer,current),'bootstrap peer process changed');
  const chain=lineage(c,row.peer.pid,query);check(chain.some(p=>sameProcess(p,gateIdentity)),'bootstrap is not bound gate descendant');
  check(row.peer.argv===[c.node,join(dirname(b.request.path),'..','boot.mjs')].join(' ').replace('/../','/'),'exact boot peer required');
  if(peer)check(sameProcess(peer,row.peer),'bridge peer changed');else peer=row.peer;
  let value;try{value=await handle(row);}catch(error){const reply={...row,status:'UNPROVED',error:String(error),detail:undefined,sentUTC:new Date().toISOString()};record('bridge-reply-attempt-'+sequence,reply);await response.write(reply);record('bridge-reply-sent-'+sequence,{status:'UNPROVED'});throw error;}
  const reply={...row,...value,status:'OBSERVED',detail:undefined,sentUTC:new Date().toISOString()};record('bridge-reply-attempt-'+sequence,reply);await response.write(reply);record('bridge-reply-sent-'+sequence,{status:'OBSERVED'});
  if(row.phase==='result')return {row,peer,chain};index++;
 }}finally{request.close();response.close();}
}

export function validateCheckpoint(row,b,phase,token,now=Date.now()) {
 const native=row?.nativeCheckpoint;check(row.phase===phase&&native?.status==='OBSERVED'&&native.session===b.session&&native.runId===b.runId&&native.threadId===b.threadId&&native.dispatchId===b.dispatchId&&native.helperPID===b.helperIdentity.pid&&native.token===token&&native.sameFocusedWindow===true&&native.nativeWindowCount===1&&native.nativeWindowsEqual===true,'actual live retained-window checkpoint required');
 check(native.deadlineUTC===b.deadlineUTC&&now-Date.parse(native.completedUTC)>=0&&now-Date.parse(native.completedUTC)<=2000&&now<Date.parse(b.deadlineUTC),'fresh native checkpoint deadline');return row;
}
