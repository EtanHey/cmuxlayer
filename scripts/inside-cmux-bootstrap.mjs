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
const self=fileURLToPath(import.meta.url), stage=dirname(self);
export const PINS={runner:'c2ef980fa592bc47530258193311b961a8bcfa4d87b2dfe3b22b59102c957b92',proxy:'355dd758b5fabec25da4950c7de64340bdae4afdb7f42037e35c6697879c104f',node:'832eaf52cafa7ff1364c2ca378451db14fb043d8d23a5cfd18a0a103d66226fc',cmux:'855ae2b7e14132402979e5b0e202ce85dc1ae7e6c840884530930bd3bc3adbc1'};
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
 check(focus?.observer==='NATIVE_CUA' && focus.windowId && focus.workspaceId && focus.surfaceId && focus.artifactPath?.startsWith('/Users/happycampr/'),'native pre-bootstrap focus witness required');
 check(/^[a-f0-9]{64}$/.test(focus.sha256 ?? ''),'native focus artifact hash required');
 check(Date.parse(focus.observedUTC)>=Date.parse(c.notBeforeUTC) && Date.parse(focus.observedUTC)<=Date.parse(p.bootstrap.createdUTC) && Date.parse(p.bootstrap.createdUTC)<=now,'fresh ordered native focus/creation observations required');
 check(typeof p.bootstrap.marker==='string' && p.bootstrap.marker.startsWith('INSIDE_BBE_') && p.bootstrap.marker!==c.marker,'distinct bootstrap marker required');
 check(p.retainedBaseline.path==='/Users/happycampr/Library/Caches/cmuxlayer-firstcase-upload-840580af-20261009T0238Z-9a0e71ac-5f78-4ac0-a497-0697c6c96cfd/live-baseline-private.json' && /^[a-f0-9]{64}$/.test(p.retainedBaseline.sha256),'retained private socket provenance required');
 check(/^[a-f0-9]{64}$/.test(p.bootstrapSha256 ?? ''),'bootstrap hash required');
 check(Date.parse(c.mutationEndUTC)-now>=120000,'bootstrap needs120seconds mutation plus retained restoration reserve');
 return c;
}
export async function admitted(p,operation) {validatePlan(p);return operation(p);}
function contains(value,text) {return value===text || (value && typeof value==='object' && Object.values(value).some(v=>contains(v,text)));}
async function execute(p) {
 const admission=validatePlan(p), c={...admission};
 check(process.platform==='darwin' && process.arch==='arm64' && process.getuid()===501 && fs.lstatSync('/dev/console').uid===501 && hostname()===c.host && userInfo().homedir==='/Users/happycampr' && fs.realpathSync(process.execPath)===c.node,'normal501 M1/pinned Node context required');
 const stageStat=fs.lstatSync(stage);
 check(stageStat.isDirectory() && !stageStat.isSymbolicLink() && stageStat.uid===501 && (stageStat.mode&0o777)===0o700,'private501 bootstrap stage required');
 for(const [file,pin] of [[self,p.bootstrapSha256],[join(stage,'original-roots-first-case.mjs'),PINS.runner],[join(stage,'original-roots-first-case.proxy.mjs'),PINS.proxy],[c.node,PINS.node],[c.cmux,PINS.cmux]])check(hash(file)===pin,'staged executable hash mismatch');
 verifyCandidate(c.candidate,c.manifestPath);
 const provenance=fs.lstatSync(p.retainedBaseline.path);
 check(provenance.isFile() && !provenance.isSymbolicLink() && provenance.uid===501 && (provenance.mode&0o777)===0o600 && hash(p.retainedBaseline.path)===p.retainedBaseline.sha256,'private provenance identity changed');
 check(contains(JSON.parse(fs.readFileSync(p.retainedBaseline.path,'utf8')),c.socket),'socket path must come from retained private receipt');
 const focusStat=fs.lstatSync(p.beforeBootstrapFocus.artifactPath);
 check(focusStat.isFile() && !focusStat.isSymbolicLink() && focusStat.uid===501 && (focusStat.mode&0o777)===0o600 && hash(p.beforeBootstrapFocus.artifactPath)===p.beforeBootstrapFocus.sha256,'native focus artifact identity changed');
 const focusWitness=JSON.parse(fs.readFileSync(p.beforeBootstrapFocus.artifactPath,'utf8'));
 for(const key of ['observer','observedUTC','windowId','workspaceId','surfaceId'])check(focusWitness[key]===p.beforeBootstrapFocus[key],'native focus witness differs from plan');
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
 const outcome={status:'FAIL',bootstrap:p.bootstrap,beforeBootstrapFocus:p.beforeBootstrapFocus,ancestry:chain,case:null,artifacts:'RETAINED'};
 try {
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
  check([bootWorkspace.id,bootWorkspace.ref].filter(Boolean).includes(identify.focused?.workspace_ref),'native bootstrap focus no longer matches observed empty terminal');
  check(bootstrapPanes.panes.length===1 && bootstrapPanes.panes[0].ref===p.bootstrap.anchorPaneRef && bootstrapSurfaces.surfaces.length===1 && bootstrapSurfaces.surfaces[0].id===p.bootstrap.anchorSurfaceId,'bootstrap anchor changed');
  check(!workspaces.workspaces.some(w=>w.title===c.marker),'case marker already exists; no replay');
  record('pre-case-baseline',{identify,workspaces,current,windows,bootstrapPanes,bootstrapSurfaces,beforeBootstrapFocus:p.beforeBootstrapFocus});
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
  child=spawn(c.node,[join(stage,'original-roots-first-case.mjs'),'--execute',config],{env:{HOME:'/Users/happycampr',PATH:'/usr/bin:/bin'},stdio:'inherit'});
  const exited=new Promise((ok,no)=>{child.once('exit',(code,signal)=>ok({code,signal}));child.once('error',no);});
  await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});
  childIdentity=queryProcess(child.pid,windowBudget(c,1,1000));record('runner-identity',childIdentity);
  check(childIdentity.uid===501 && childIdentity.argv===[c.node,join(stage,'original-roots-first-case.mjs'),'--execute',config].join(' '),'runner identity unproved');
  const deadline=setTimeout(()=>{outcome.deadlineExpired=true;record('deadline-expired',{identity:childIdentity,outcome:'UNKNOWN',foregroundParent:'RETAINED_FOR_OWNED_CLEANUP'});console.error('restoration deadline expired; retain foreground ancestry and report blocker');},Math.max(0,Date.parse(c.deadlineUTC)-Date.now()));
  let result;try{result=await exited;}finally{clearTimeout(deadline);}record('runner-exit',result);
  outcome.status='CASE_ENDED_RESTORATION_PENDING';outcome.runnerExit=result;
  if(fs.existsSync(join(c.root,'result.json')))outcome.runnerResult=JSON.parse(fs.readFileSync(join(c.root,'result.json'),'utf8'));
 }catch(error){outcome.error=String(error);}
 finally {
  backend?.disconnect();
  outcome.restoreProposal={caseWorkspace:outcome.case,bootstrapWorkspace:p.bootstrap,beforeBootstrapFocus:p.beforeBootstrapFocus,runnerResources:'Use independent runner result identities/absence readback; never unknown PID cleanup',sequence:['Verify runner-owned children absent or mark uncertainty',outcome.case?'Revalidate/close only ACK-bound created case workspace':'Case ownership UNKNOWN; no case closure or creation replay','Restore current validated pre-bootstrap focus via native executor','Close only bootstrap workspace LAST after foreground jobs confirmed absent'],artifactDeletion:'NOT_AUTHORIZED_Q2_UNANSWERED',overallAcceptance:'REQUIRES_PARENT_READBACK'};
  record('result',outcome);console.log(JSON.stringify({status:outcome.status,receipt:join(receipts,'result.json'),overallAcceptance:'UNPROVED'}));
 }
 if(outcome.status==='FAIL' || outcome.runnerExit?.code!==0 || outcome.deadlineExpired)process.exitCode=1;
}
if(process.argv[1] && resolve(process.argv[1])===self) {
 const plan=JSON.parse(fs.readFileSync(join(stage,'bootstrap.reviewed.json'),'utf8'));
 await admitted(plan,execute);
}
