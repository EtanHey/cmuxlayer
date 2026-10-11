#!/opt/homebrew/Cellar/node/26.10.0_2/bin/node
// Foreground, one owned case; native executor supplies reviewed private inputs.
import * as fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostname,userInfo} from 'node:os';
import {validateConfig,windowBudget,withinWindow,verifyCandidate,sameProcess} from './original-roots-first-case.mjs';
import {ancestry,queryProcess} from './original-roots-first-case.proxy.mjs';
import {validateFocusWitness,readFocusReceipt,validateTopology,executorReadiness} from './native-focus-episode.mjs';
import {BridgeClient,validateCheckpoint} from './native-focus-bridge.mjs';
import {privateJSON} from './bootstrap-gate.mjs';
import {execFileSync} from 'node:child_process';
const self=fileURLToPath(import.meta.url), stage=dirname(self);
export const PINS={runner:'7b11a268974983d7e8efc1a061bcf69f90d821d5bb729f1b1b2162edc1566ad7',proxy:'355dd758b5fabec25da4950c7de64340bdae4afdb7f42037e35c6697879c104f',node:'832eaf52cafa7ff1364c2ca378451db14fb043d8d23a5cfd18a0a103d66226fc',cmux:'855ae2b7e14132402979e5b0e202ce85dc1ae7e6c840884530930bd3bc3adbc1'};
const check=(ok,why)=>{if(!ok)throw Error(why);};
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export function validatePlan(p,now=Date.now()) {
 check(p.sourceApproved===true && p.executionApproved===true,'fresh parent source/execution approval required');
 const c=p.runner; validateConfig(c,now);
 for(const [key,pin] of Object.entries(PINS))check(c[key==='runner'?'runnerSha256':key==='proxy'?'proxyRunnerSha256':key+'Sha256']===pin,'unreviewed executable bytes: '+key);
 check(c.node==='/opt/homebrew/Cellar/node/26.10.0_2/bin/node' && c.cmux==='/Applications/cmux.app/Contents/Resources/bin/cmux','exact retained runtime paths required');
 check(c.candidate==='/Users/happycampr/Library/Caches/cmuxlayer-original-roots-d539fbef','exact staged candidate required');
 check(p.bootstrap.workspaceId===c.workspaceId && p.bootstrap.anchorSurfaceId===c.anchorSurfaceId && p.bootstrap.anchorPaneRef===c.anchorPaneRef,'admission identities must be observed bootstrap anchor');
 const focus=p.beforeBootstrapFocus;
 validateFocusWitness(focus,c,now);
 check(focus.artifactPath?.startsWith('/Users/happycampr/'),'private compound focus artifact required');
 check(/^[a-f0-9]{64}$/.test(focus.sha256 ?? ''),'native focus artifact hash required');
 check(Date.parse(focus.observedUTC)>=Date.parse(c.notBeforeUTC) && Date.parse(focus.observedUTC)<=Date.parse(p.bootstrap.createdUTC) && Date.parse(p.bootstrap.createdUTC)<=now,'fresh ordered native focus/creation observations required');
 check(typeof p.bootstrap.marker==='string' && p.bootstrap.marker.startsWith('INSIDE_BBE_') && p.bootstrap.marker!==c.marker,'distinct bootstrap marker required');
 check(p.retainedBaseline.path===socketWitnessPath(c) && /^[a-f0-9]{64}$/.test(p.retainedBaseline.sha256),'fresh named private socket witness in owned stage required');
 check(/^[a-f0-9]{64}$/.test(p.bootstrapSha256 ?? ''),'bootstrap hash required');
 check(/^[a-f0-9]{64}$/.test(p.episodeControllerSha256 ?? ''),'episode controller hash required');
 check(/^[a-f0-9]{64}$/.test(p.bridgeSha256 ?? '')&&p.bridge?.session===focus.session&&p.bridge?.nonce===p.executorWitness?.ack?.nonce&&p.executorWitness?.contract==='TERMINAL_INITIAL_COMMAND_GATE','bound gate/helper bridge required');
 check(Date.parse(c.mutationEndUTC)-now>=120000,'bootstrap needs120seconds mutation plus retained restoration reserve');
 return c;
}
export async function admitted(p,operation) {validatePlan(p);return operation(p);}
export const socketWitnessPath=c=>join(stage,'socket-witness-'+c.runId+'.private.json');
export function validateSocketWitness(p,c,w,now=Date.now()) {
 check(p.retainedBaseline.path===socketWitnessPath(c),'socket witness must be named in owned stage');
 check(Date.parse(w.observedUTC)>=Date.parse(c.notBeforeUTC) && Date.parse(w.observedUTC)<=now,'fresh socket observation required');
 check(w.dispatchId===c.coordinationReceipt.dispatchId && w.threadId===c.coordinationReceipt.threadId,'socket witness coordination mismatch');
 check(sameProcess(w.appProcess,c.appProcess) && w.appProcess.executable==='/Applications/cmux.app/Contents/MacOS/cmux','socket witness GUI identity mismatch');
 check(w.socket?.path===c.socket && w.socket.type==='socket' && w.socket.symlink===false && ['uid','dev','ino'].every(k=>w.socket[k]===c.socketIdentity[k]),'socket witness endpoint identity mismatch');
 const l=w.listener;
 check(l?.method==='LSOF_GUI_PID_UNIX' && l.role==='LISTENING_OWNER' && sameProcess(l.appProcess,c.appProcess) && l.socketPath===c.socket,'positive same-GUI listener witness required');
 check(l.evidencePath===join(stage,'gui-listener-'+c.runId+'.private.txt') && /^[a-f0-9]{64}$/.test(l.sha256 ?? ''),'named private listener evidence required');
 return l;
}
export function guiSocketListed(text,pid,path,canonical=value=>value) {
 const records=text.trim().split(/(?=^p[0-9]+$)/m).filter(Boolean);
 return records.length===1 && records[0].split('\n')[0]==='p'+pid && records[0].split(/(?=^f[^\n]+$)/m).slice(1).some(fd=>{
  const names=fd.split('\n').filter(line=>line.startsWith('n/'));
  if(!/^tunix$/im.test(fd) || names.length!==1 || names[0].includes('->'))return false;
  try{return canonical(names[0].slice(1))===path;}catch{return false;}
 });
}
async function execute(p) {
 const admission=validatePlan(p), c={...admission};
 check(process.platform==='darwin' && process.arch==='arm64' && process.getuid()===501 && fs.lstatSync('/dev/console').uid===501 && hostname()===c.host && userInfo().homedir==='/Users/happycampr' && fs.realpathSync(process.execPath)===c.node,'normal501 M1/pinned Node context required');
 const stageStat=fs.lstatSync(stage);
 check(stageStat.isDirectory() && !stageStat.isSymbolicLink() && stageStat.uid===501 && (stageStat.mode&0o777)===0o700,'private501 bootstrap stage required');
 for(const [file,pin] of [[join(stage,'native-focus-bridge.mjs'),p.bridgeSha256],[join(stage,'native-focus-episode.mjs'),p.episodeControllerSha256],[self,p.bootstrapSha256],[join(stage,'original-roots-first-case.mjs'),PINS.runner],[join(stage,'original-roots-first-case.proxy.mjs'),PINS.proxy],[c.node,PINS.node],[c.cmux,PINS.cmux]])check(hash(file)===pin,'staged executable hash mismatch');
 verifyCandidate(c.candidate,c.manifestPath);
 const provenance=fs.lstatSync(p.retainedBaseline.path);
 check(provenance.isFile() && !provenance.isSymbolicLink() && fs.realpathSync(p.retainedBaseline.path)===p.retainedBaseline.path && provenance.uid===501 && (provenance.mode&0o777)===0o600 && hash(p.retainedBaseline.path)===p.retainedBaseline.sha256,'private provenance identity changed');
 const listener=validateSocketWitness(p,c,JSON.parse(fs.readFileSync(p.retainedBaseline.path,'utf8')));
 const listenerStat=fs.lstatSync(listener.evidencePath);
 check(listenerStat.isFile() && !listenerStat.isSymbolicLink() && fs.realpathSync(listener.evidencePath)===listener.evidencePath && listenerStat.uid===501 && (listenerStat.mode&0o777)===0o600 && hash(listener.evidencePath)===listener.sha256,'private listener evidence identity changed');
 check(fs.realpathSync(c.socket)===c.socket && guiSocketListed(fs.readFileSync(listener.evidencePath,'utf8'),c.appProcess.pid,c.socket,path=>fs.realpathSync(path)),'canonical GUI socket is not attributed by private listener evidence');
 const focusStat=fs.lstatSync(p.beforeBootstrapFocus.artifactPath);
 check(focusStat.isFile() && !focusStat.isSymbolicLink() && focusStat.uid===501 && (focusStat.mode&0o777)===0o600 && hash(p.beforeBootstrapFocus.artifactPath)===p.beforeBootstrapFocus.sha256,'native focus artifact identity changed');
 readFocusReceipt(p.beforeBootstrapFocus,c);
 const witness=p.executorWitness,liveGate=queryProcess(witness.ack.identity.pid,1000);
 const gateACK=privateJSON(witness.ackPath);check(gateACK.sha256===witness.expected.gateACKSHA256&&JSON.stringify(gateACK.value)===JSON.stringify(witness.ack),'actual gate ACK bytes changed');
 const release=privateJSON(witness.releasePath),accepted=privateJSON(witness.acceptedPath);
 executorReadiness(witness,c,{live:liveGate,chain:ancestry(c,liveGate.pid,queryProcess),tty:execFileSync('/bin/ps',['-p',String(liveGate.pid),'-o','tty='],{encoding:'utf8',timeout:1000}).trim(),release:release.value,releaseSHA256:release.sha256,accepted:accepted.value,planSHA256:hash(join(stage,'bootstrap.reviewed.json'))});
 let bridge;
 const nativeCheck=async phase=>validateCheckpoint(await bridge.call(phase),p.bridge,phase,p.beforeBootstrapFocus.token);
 const fresh=()=>{
  validateConfig(c);const socket=fs.lstatSync(c.socket);
  check(socket.isSocket() && !socket.isSymbolicLink() && ['uid','dev','ino'].every(k=>socket[k]===c.socketIdentity[k]),'socket identity changed');
  return ancestry(c,process.pid,queryProcess);
 };
 const chain=fresh();windowBudget(c,120000);
 const receipts=join(stage,'receipt-'+c.runId);fs.mkdirSync(receipts,{mode:0o700});
 let sequence=0,backend,child,childIdentity;
 const record=(name,value)=>write(join(receipts,name+'.json'),value);
 const uncertain=(label,value)=>{try{record('uncertain-'+(++sequence),{label,...value});}catch(error){console.error('uncertainty retention failed; acceptance UNPROVED');}};
 const rpc=async(label,operation)=>{fresh();return withinWindow(c,label,operation,uncertain);};
 const outcome={status:'FAIL',caseCreateAttempts:0,runnerSpawnAttempts:0,bootstrap:p.bootstrap,beforeBootstrapFocus:p.beforeBootstrapFocus,ancestry:chain,case:null,artifacts:'RETAINED'};
 try {
  bridge=new BridgeClient(p.bridge,c);
  const {CmuxSocketClient}=await import(pathToFileURL(join(c.candidate,'dist/cmux-socket-client.js')));
  backend=new CmuxSocketClient({socketPath:c.socket});
  const identify=await rpc('identify',()=>backend.identify());
  const workspaces=await rpc('list',()=>backend.listWorkspaces());
  const current=await rpc('current',()=>backend.call('workspace.current',{}));
  const windows=await rpc('window',()=>backend.listWindows());
  const bootstrapPanes=await rpc('bootstrap-panes',()=>backend.listPanes({workspace:p.bootstrap.workspaceId}));
  const bootstrapSurfaces=await rpc('bootstrap-anchor',()=>backend.listPaneSurfaces({workspace:p.bootstrap.workspaceId,pane:p.bootstrap.anchorPaneRef}));
  check(workspaces.workspaces.some(w=>w.id===p.bootstrap.workspaceId && w.title===p.bootstrap.marker),'bootstrap UUID/marker absent');
  const bootWorkspace=workspaces.workspaces.find(w=>w.id===p.bootstrap.workspaceId);
  check([bootWorkspace.id,bootWorkspace.ref].filter(Boolean).includes(identify.focused?.workspace_ref),'released bootstrap no longer matches ACK-bound terminal gate');
  check(bootstrapPanes.panes.length===1 && bootstrapPanes.panes[0].ref===p.bootstrap.anchorPaneRef && bootstrapSurfaces.surfaces.length===1 && bootstrapSurfaces.surfaces[0].id===p.bootstrap.anchorSurfaceId,'bootstrap anchor changed');
  validateTopology(windows,workspaces,current,identify,bootstrapPanes,bootstrapSurfaces,{windowId:p.beforeBootstrapFocus.protocolWindowId,workspaceId:p.bootstrap.workspaceId,surfaceId:p.bootstrap.anchorSurfaceId,paneRef:p.bootstrap.anchorPaneRef});
  check(!workspaces.workspaces.some(w=>w.title===c.marker),'case marker already exists; no replay');
  record('pre-case-baseline',{identify,workspaces,current,windows,bootstrapPanes,bootstrapSurfaces,beforeBootstrapFocus:p.beforeBootstrapFocus});
  await nativeCheck('before-create');outcome.caseCreateAttempts=1;record('case-create-attempt',{marker:c.marker});
  windowBudget(c,60000);const created=await rpc('create-case',()=>backend.createWorkspace(c.marker));outcome.status='PENDING_UNKNOWN_CASE_IDENTITY';record('case-creation-ack',created);
  const after=await rpc('resolve-case',()=>backend.listWorkspaces());
  record('case-creation-observation',after);
  const ack=created?.workspace;
  check(typeof ack==='string' && ack.trim().length>0,'creation ACK identity missing; retained UNKNOWN, no replay/ownership');
  const matches=after.workspaces.filter(w=>w.title===c.marker && !workspaces.workspaces.some(old=>old.id===w.id));check(matches.length===1,'created case identity ambiguous; retained');
  const identifies=w=>[w.id,w.ref].filter(Boolean).includes(ack);
  check(identifies(matches[0]) && after.workspaces.filter(identifies).length===1 && !workspaces.workspaces.some(identifies),'creation ACK does not identify exactly one new case; retained UNKNOWN, no replay/ownership');
  outcome.case={workspaceId:matches[0].id,marker:c.marker};
  outcome.status='FAIL';
  const panes=await rpc('case-panes',()=>backend.listPanes({workspace:outcome.case.workspaceId}));check(panes.panes.length===1,'one new case anchor required');
  const surfaces=await rpc('case-anchor',()=>backend.listPaneSurfaces({workspace:outcome.case.workspaceId,pane:panes.panes[0].ref}));check(surfaces.surfaces.length===1,'one new case surface required');
  Object.assign(c,{workspaceId:outcome.case.workspaceId,anchorPaneRef:panes.panes[0].ref,anchorSurfaceId:surfaces.surfaces[0].id});validateConfig(c);fresh();windowBudget(c,60000);
  const config=join(receipts,'runner.reviewed.json');write(config,c);record('case-topology',{after,panes,surfaces});
  fresh();windowBudget(c,60000);
  outcome.focusBeforeRunner=await nativeCheck('before-runner');windowBudget(c,60000);
  outcome.runnerSpawnAttempts=1;record('runner-spawn-attempt',{command:[c.node,join(stage,'original-roots-first-case.mjs'),'--execute',config]});
  child=spawn(c.node,[join(stage,'original-roots-first-case.mjs'),'--execute',config],{env:{HOME:'/Users/happycampr',PATH:'/usr/bin:/bin'},stdio:'inherit'});
  const exited=new Promise((ok,no)=>{child.once('exit',(code,signal)=>ok({code,signal}));child.once('error',no);});
  await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});
  childIdentity=queryProcess(child.pid,windowBudget(c,1,1000));record('runner-identity',childIdentity);
  check(childIdentity.uid===501 && childIdentity.argv===[c.node,join(stage,'original-roots-first-case.mjs'),'--execute',config].join(' '),'runner identity unproved');
  let deadline;const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>{outcome.deadlineExpired=true;record('deadline-expired',{identity:childIdentity,outcome:'UNKNOWN',foregroundParent:'RETAINED_FOR_OWNED_CLEANUP'});try{check(sameProcess(childIdentity,queryProcess(child.pid,1000)),'runner identity changed; no signal');child.kill('SIGTERM');record('runner-deadline-stop',{identity:childIdentity,signal:'SIGTERM'});}catch(error){record('runner-retained',{error:String(error)});}reject(Error('bounded runner deadline'));},Math.max(0,Math.min(60000,Date.parse(c.mutationEndUTC)-Date.now())));});
  let result;try{result=await Promise.race([exited,timeout]);}finally{clearTimeout(deadline);}record('runner-exit',result);
  outcome.focusAfterRunner=await nativeCheck('after-runner');
  outcome.status='CASE_ENDED_RESTORATION_PENDING';outcome.runnerExit=result;
  if(fs.existsSync(join(c.root,'result.json')))outcome.runnerResult=JSON.parse(fs.readFileSync(join(c.root,'result.json'),'utf8'));
 }catch(error){outcome.error=String(error);}
 finally {
  backend?.disconnect();
  outcome.restoreProposal={nativeToken:p.beforeBootstrapFocus.token,restorationReceipts:{cmux:'UNATTEMPTED_REQUIRES_LIVE_RETAINED_EPISODE',original:'UNATTEMPTED_REQUIRES_LIVE_RETAINED_EPISODE'},caseWorkspace:outcome.case,bootstrapWorkspace:p.bootstrap,beforeBootstrapFocus:p.beforeBootstrapFocus,runnerResources:'Use independent runner result identities/absence readback; never unknown PID cleanup',sequence:['Verify runner-owned children absent or mark uncertainty',outcome.case?'Revalidate/close only ACK-bound created case workspace':'Case ownership UNKNOWN; no case closure or creation replay','Restore current validated pre-bootstrap focus via native executor','Close only bootstrap workspace LAST after foreground jobs confirmed absent'],artifactDeletion:'NOT_AUTHORIZED_Q2_UNANSWERED',overallAcceptance:'REQUIRES_PARENT_READBACK'};
  record('result',outcome);
  try{await bridge?.call('result',{resultSHA256:hash(join(receipts,'result.json'))});}catch(error){record('result-notification-unproved',{error:String(error),replay:false});}finally{bridge?.close();}
  console.log(JSON.stringify({status:outcome.status,receipt:join(receipts,'result.json'),overallAcceptance:'UNPROVED'}));
 }
 if(outcome.status==='FAIL' || outcome.runnerExit?.code!==0 || outcome.deadlineExpired)process.exitCode=1;
}
if(process.argv[1] && resolve(process.argv[1])===self) {
 const plan=JSON.parse(fs.readFileSync(join(stage,'bootstrap.reviewed.json'),'utf8'));
 await admitted(plan,execute);
}
