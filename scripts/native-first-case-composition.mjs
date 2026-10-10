#!/opt/homebrew/Cellar/node/26.10.0_2/bin/node
// ONE command-at-create gate, ONE persistent helper, ONE original serving case.
import * as fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostname} from 'node:os';
import {validateConfig,withinWindow,verifyCandidate,sameProcess} from './original-roots-first-case.mjs';
import {ancestry,queryProcess} from './original-roots-first-case.proxy.mjs';
import {Episode,validateTopology} from './native-focus-episode.mjs';
import {createBridge,serveBridge,validateCheckpoint} from './native-focus-bridge.mjs';
import {privateJSON,digest,bindCreation,validateGateACK} from './bootstrap-gate.mjs';
import {validatePlan,validateSocketWitness,guiSocketListed,PINS} from './inside-cmux-bootstrap.mjs';
const self=fileURLToPath(import.meta.url),stage=dirname(self),check=(ok,why)=>{if(!ok)throw Error(why);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const write=(path,value)=>fs.writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const hash=path=>digest(fs.readFileSync(path));
export function processState(pid){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return {state:'ABSENT',pid};return {state:'UNKNOWN',pid,error:String(e)};}try{return {state:'LIVE',identity:queryProcess(pid,1000)};}catch(e){return {state:'UNKNOWN',pid,error:String(e)};}}
export async function cleanupProcesses(rows,deadline,deps={state:processState,signal:(pid)=>process.kill(pid,'SIGTERM'),pause}) {
 const result=[];
 for(const row of rows){let receipt={identity:row.identity,status:'UNPROVED'};result.push(receipt);const pid=row.identity?.pid;
  try{check(Number.isSafeInteger(pid)&&pid>1&&row.identity.uid===501&&row.identity.start&&row.identity.argv,'recorded owned process required');check(Date.now()<deadline,'cleanup deadline');
   let current=await deps.state(pid);if(current.state==='ABSENT'){receipt.status='ABSENT';continue;}
   check(current.state==='LIVE'&&sameProcess(row.identity,current.identity),'live identity unknown/changed; no signal');
   if(!row.stopAlreadyRequested){await deps.signal(pid);receipt.signal='SIGTERM';}else receipt.previousStop='RETAINED_NO_REPLAY';
   const end=Math.min(deadline,Date.now()+2000);while(Date.now()<end){current=await deps.state(pid);if(current.state==='ABSENT'){receipt.status='ABSENT';break;}check(current.state==='LIVE'&&sameProcess(row.identity,current.identity),'process identity changed after stop');await deps.pause(20);}
  }catch(e){receipt.error=String(e);}
 }
 return {status:result.every(r=>r.status==='ABSENT')?'ALL_ABSENT':'UNKNOWN_RETAINED',processes:result};
}
export async function readSelected(backend,expected) {
 const windows=await backend.listWindows(),workspaces=await backend.listWorkspaces(),current=await backend.call('workspace.current',{}),identify=await backend.identify();
 const selected=workspaces.workspaces.filter(w=>w.selected===true);check(selected.length===1&&selected[0].id,'one selected UUID required');
 const panes=await backend.listPanes({workspace:selected[0].id}),focused=panes.panes.filter(p=>p.focused===true);check(focused.length===1,'one focused pane required');
 const surfaces=await backend.listPaneSurfaces({workspace:selected[0].id,pane:focused[0].ref}),choices=surfaces.surfaces.filter(s=>s.selected===true||s.focused===true||s.selected_in_pane===true);check(choices.length===1&&choices[0].id,'one selected surface required');
 const topology=validateTopology(windows,workspaces,current,identify,panes,surfaces,expected??{workspaceId:selected[0].id,surfaceId:choices[0].id,paneRef:focused[0].ref});
 check(/^[a-f0-9-]{36}$/i.test(topology.windowId),'actual protocol window UUID required for scoped create');return {topology,windows,workspaces,current,identify,panes,surfaces};
}
export async function closeACKOwned(owned,backend,checkpoint,record) {
 check(owned?.workspaceId&&owned.marker&&owned.ack,'positive creation ACK ownership required');await checkpoint();
 const before=await backend.listWorkspaces(),token=owned.ack.workspace_id??owned.ack.workspace_ref??owned.ack.workspace;
 const matches=before.workspaces.filter(w=>w.id===owned.workspaceId&&w.title===owned.marker),aliases=before.workspaces.filter(w=>[w.id,w.ref].includes(token));
 check(matches.length===1&&aliases.length===1&&aliases[0].id===owned.workspaceId,'owned UUID/title/ACK changed');
 await checkpoint();record('close-attempt',{workspaceId:owned.workspaceId,ack:owned.ack});
 await backend.deleteWorkspace(owned.workspaceId);const after=await backend.listWorkspaces();record('close-readback',after);check(!after.workspaces.some(w=>w.id===owned.workspaceId),'owned workspace closure unproved');return {status:'CLOSED_ACK_OWNED',workspaceId:owned.workspaceId};
}
export async function restoreAndClose({episode,backend,baseline,expected,ownedCase,ownedBootstrap,processes,deadline},deps={}) {
 const record=deps.record??(()=>{}),close=deps.close??closeACKOwned,read=deps.read??readSelected;
 const result={processes,caseClosure:{status:'UNATTEMPTED'},cmux:{status:'RESTORATION_UNPROVED'},bootstrapClosure:{status:'UNATTEMPTED'},original:{status:'RESTORATION_UNPROVED'}};
 const guard=async()=>{check(Date.now()<deadline,'restoration reserve exhausted');await episode.check('cmux');return read(backend,expected);};
 try{
  check(processes.status==='ALL_ABSENT','foreground/owned process absence unproved');await guard();
  if(ownedCase){result.caseClosure=await close(ownedCase,backend,guard,(name,value)=>record('case-'+name,value));const after=await read(backend);check([ownedBootstrap.workspaceId,baseline.workspaceId].includes(after.topology.workspaceId),'unexpected selection after CASE closure');expected=after.topology;}
  await guard();const target=await backend.listWorkspaces();check(target.workspaces.some(w=>w.id===baseline.workspaceId),'baseline workspace exited');
  const panes=await backend.listPanes({workspace:baseline.workspaceId}),surfaces=await backend.listPaneSurfaces({workspace:baseline.workspaceId,pane:baseline.paneRef});
  check(panes.panes.some(p=>p.ref===baseline.paneRef)&&surfaces.surfaces.some(s=>s.id===baseline.surfaceId),'retained baseline pane/surface lost');
  await guard();await backend.selectWorkspace(baseline.workspaceId);const selected=await read(backend);check(selected.topology.workspaceId===baseline.workspaceId&&selected.topology.windowId===baseline.windowId,'workspace selection ACK unproved');expected=selected.topology;
  await guard();await backend.focusSurface(baseline.surfaceId,{workspace:baseline.workspaceId});await read(backend,baseline);expected=baseline;
  const native=await episode.restore('cmux','cmux');result.cmux={status:'RESTORED',protocol:baseline,native};record('composition-restore-cmux',result.cmux);
  result.bootstrapClosure=await close(ownedBootstrap,backend,guard,(name,value)=>record('bootstrap-'+name,value));await guard();
  const original=await episode.restore('original','cmux');result.original={status:'RESTORED',native:original};record('composition-restore-original',result.original);
 }catch(error){result.error=String(error);}finally{record('cleanup-restoration',result);}return result;
}
async function waitFile(path,end){while(Date.now()<end){try{return privateJSON(path);}catch(e){if(e.code!=='ENOENT')throw e;}await pause(25);}throw Error('bounded receipt deadline: '+path);}
function socketGuard(c){check(sameProcess(c.appProcess,queryProcess(c.appProcess.pid,1000)),'GUI process changed');const s=fs.lstatSync(c.socket);check(s.isSocket()&&!s.isSymbolicLink()&&fs.realpathSync(c.socket)===c.socket&&['uid','dev','ino'].every(k=>s[k]===c.socketIdentity[k]),'canonical GUI socket changed');}
export async function executeEpisode(p) {
 const c={...p.runner};check(p.sourceApproved===true&&p.executionApproved===true&&p.executorContract==='TERMINAL_INITIAL_COMMAND_GATE_V065','reviewed parent command-at-create contract required');validateConfig(c);check(hostname()===c.host&&process.platform==='darwin'&&process.arch==='arm64'&&process.getuid()===501&&fs.realpathSync(process.execPath)===c.node&&hash(c.node)===PINS.node&&c.nodeSha256===PINS.node&&c.runnerSha256===PINS.runner&&c.proxyRunnerSha256===PINS.proxy&&c.cmuxSha256===PINS.cmux,'exact native host/runtime/original pins required');
 check(/^\/[A-Za-z0-9_./-]+$/.test(stage)&&resolve(stage)===stage,'simple canonical initial_command path required');
 for(const name of ['boot.mjs','bootstrap-gate.mjs','native-focus-episode.mjs','native-focus-bridge.mjs','native-first-case-composition.mjs','native-focus-episode','original-roots-first-case.mjs','original-roots-first-case.proxy.mjs'])check(/^[a-f0-9]{64}$/.test(p.sourcePins?.[name]??''),'mandatory source/binary pin: '+name);
 check(p.sourcePins['original-roots-first-case.mjs']===PINS.runner&&p.sourcePins['original-roots-first-case.proxy.mjs']===PINS.proxy,'original runner/proxy source pins required');
 const version=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString','/Applications/cmux.app/Contents/Info.plist'],{encoding:'utf8',timeout:1000}).trim();check(version==='0.65.0','accepted cmux v0.65.0 executor route required');
 const s=fs.lstatSync(stage);check(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===501&&(s.mode&0o777)===0o700&&fs.realpathSync(stage)===stage,'private canonical stage required');
 for(const [name,pin] of Object.entries(p.sourcePins)){check(/^[A-Za-z0-9.-]+$/.test(name)&&/^[a-f0-9]{64}$/.test(pin)&&hash(join(stage,name))===pin,'staged source pin changed: '+name);const file=join(stage,name),stat=fs.lstatSync(file),executable=['boot.mjs','bootstrap-gate.mjs','native-first-case-composition.mjs','native-focus-episode'].includes(name);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===501&&fs.realpathSync(file)===file&&(stat.mode&0o777)===(executable?0o700:0o600),'private staged file identity/mode changed: '+name);}
 for(const path of [c.root,join(stage,'bootstrap.reviewed.json'),join(stage,'gate-config.json'),join(stage,'release-'+c.runId+'.json')]){try{fs.lstatSync(path);throw Error('fresh owned path collision: '+path);}catch(e){if(e.code!=='ENOENT')throw e;}}
 verifyCandidate(c.candidate,c.manifestPath);socketGuard(c);
 const socketReceipt=privateJSON(p.retainedBaseline.path);check(socketReceipt.sha256===p.retainedBaseline.sha256,'fresh socket witness hash');const listener=validateSocketWitness(p,c,socketReceipt.value),ls=fs.lstatSync(listener.evidencePath);check(ls.isFile()&&!ls.isSymbolicLink()&&ls.nlink===1&&ls.uid===501&&(ls.mode&0o777)===0o600&&fs.realpathSync(listener.evidencePath)===listener.evidencePath,'private listener evidence required');const raw=fs.readFileSync(listener.evidencePath);check(hash(listener.evidencePath)===listener.sha256&&guiSocketListed(raw.toString(),c.appProcess.pid,c.socket,path=>fs.realpathSync(path)),'positive GUI listener required');
 const {CmuxSocketClient}=await import(pathToFileURL(join(c.candidate,'dist/cmux-socket-client.js'))),backend=new CmuxSocketClient({socketPath:c.socket});
 const episode=new Episode({runId:c.runId,dispatchId:c.coordinationReceipt.dispatchId,threadId:c.coordinationReceipt.threadId,deadlineUTC:c.deadlineUTC,helper:join(stage,'native-focus-episode'),helperSHA256:p.sourcePins['native-focus-episode'],receiptDir:join(stage,'episode-'+c.runId)});
 const bridgeAbort=new AbortController();let restorationAttempted=false;
 let ownedBootstrap,ownedCase,baseline,expected,gate,gateIdentity,bridge,bootPlan,bridgeTask,outcome,bridgeFailure,releasePublished=false,bootPeer;
 const result={status:'FAIL',admitted:0,executed:0,passed:0,failed:0,unknownEffects:[],originalNative:'UNPROVED',cmuxNative:'UNPROVED'};
 const record=(name,value)=>episode.record(name,value),rpc=(label,fn)=>{socketGuard(c);return withinWindow(c,label,fn,(label,value)=>{result.unknownEffects.push({label,...value});record('unknown-'+result.unknownEffects.length,{label,...value});});};
 const checkedBackend=new Proxy(backend,{get(target,key){const value=target[key];return typeof value==='function'? (...args)=>rpc(String(key),()=>value.apply(target,args)):value;}});
 try{
  await episode.start();await episode.capture('original');
  if(episode.tokens.original.app.bundle==='/Applications/cmux.app'&&Number(episode.tokens.original.app.pid)===c.appProcess.pid)await episode.capture('cmux');else await episode.attachCmux(c.appProcess);
  const before=await readSelected(checkedBackend);baseline=before.topology;expected=baseline;
  const beforeFocus=await episode.witness(c,async()=>(await readSelected(checkedBackend,baseline)).topology,join(episode.c.receiptDir,'focus-before-bootstrap.json'));record('before-bootstrap-protocol',before);
  bridge=createBridge(episode);
  const gateConfig={runner:c,nonce:bridge.nonce,gateSHA256:p.sourcePins['bootstrap-gate.mjs'],bootSHA256:p.sourcePins['boot.mjs']};write(join(stage,'gate-config.json'),gateConfig);
  const createParams={window_id:baseline.windowId,title:'INSIDE_BBE_'+c.runId,working_directory:stage,initial_command:join(stage,'bootstrap-gate.mjs'),focus:false,eager_load_terminal:true};record('bootstrap-create-attempt',createParams);
  const ack=await rpc('workspace.create initial_command',()=>backend.call('workspace.create',createParams));record('bootstrap-create-ack',ack);
  const immediate=await episode.check('cmux');record('after-background-create-native',immediate);
  const after=await checkedBackend.listWorkspaces();ownedBootstrap=bindCreation(before.workspaces,ack,after,createParams.title);record('bootstrap-ownership',ownedBootstrap);
  await readSelected(checkedBackend,baseline);await episode.check('cmux');result.backgroundCreateFocusPreserved='OBSERVED_WINDOW_AND_PROTOCOL_EQUAL';
  const gateAckPath=join(stage,'gate-'+c.runId,'start.json');gate=await waitFile(gateAckPath,Date.parse(c.mutationEndUTC)-120000);gateIdentity=queryProcess(gate.value.identity.pid,1000);
  const panes=await checkedBackend.listPanes({workspace:ownedBootstrap.workspaceId}),surfaces=await checkedBackend.listPaneSurfaces({workspace:ownedBootstrap.workspaceId,pane:panes.panes[0]?.ref});
  check(panes.panes.length===1&&surfaces.surfaces.length===1&&surfaces.surfaces[0].id===gate.value.scope.surfaceId,'one gate ACK-bound bootstrap anchor required');ownedBootstrap.surfaceRef=surfaces.surfaces[0].ref;
  const executorExpected={nonce:bridge.nonce,gatePath:join(stage,'bootstrap-gate.mjs'),gateSHA256:p.sourcePins['bootstrap-gate.mjs'],bootSHA256:p.sourcePins['boot.mjs'],configSHA256:hash(join(stage,'gate-config.json')),gateACKSHA256:gate.sha256,creationACKSHA256:hash(join(episode.c.receiptDir,'bootstrap-create-ack.json')),topologySHA256:digest(Buffer.from(JSON.stringify({panes,surfaces})))};
  const chain=ancestry(c,gateIdentity.pid,queryProcess),tty=execFileSync('/bin/ps',['-p',String(gateIdentity.pid),'-o','tty='],{encoding:'utf8',timeout:1000}).trim();validateGateACK(gate.value,c,ownedBootstrap,executorExpected,gateIdentity,chain,tty);record('gate-independent-binding',{gateIdentity,chain,tty});
  await episode.check('cmux');await readSelected(checkedBackend,baseline);record('intentional-bootstrap-selection',{from:baseline,to:ownedBootstrap.workspaceId});
  await checkedBackend.selectWorkspace(ownedBootstrap.workspaceId);await episode.check('cmux');const selected=await readSelected(checkedBackend);check(selected.topology.workspaceId===ownedBootstrap.workspaceId,'bootstrap selection unproved');expected=selected.topology;
  await episode.check('cmux');await readSelected(checkedBackend,expected);await checkedBackend.focusSurface(gate.value.scope.surfaceId,{workspace:ownedBootstrap.workspaceId});
  const bootstrap={workspaceId:ownedBootstrap.workspaceId,anchorSurfaceId:gate.value.scope.surfaceId,anchorPaneRef:panes.panes[0].ref,marker:createParams.title,createdUTC:gate.value.observedUTC};
  expected={...baseline,workspaceId:bootstrap.workspaceId,surfaceId:bootstrap.anchorSurfaceId,paneRef:bootstrap.anchorPaneRef};await readSelected(checkedBackend,expected);await episode.check('cmux');
  bootPlan={sourceApproved:true,executionApproved:true,bootstrapSha256:p.sourcePins['boot.mjs'],episodeControllerSha256:p.sourcePins['native-focus-episode.mjs'],bridgeSha256:p.sourcePins['native-focus-bridge.mjs'],bootstrap,beforeBootstrapFocus:beforeFocus,retainedBaseline:p.retainedBaseline,runner:{...c,workspaceId:bootstrap.workspaceId,anchorSurfaceId:bootstrap.anchorSurfaceId,anchorPaneRef:bootstrap.anchorPaneRef},bridge,executorWitness:{contract:'TERMINAL_INITIAL_COMMAND_GATE',ack:gate.value,ackPath:gateAckPath,owned:ownedBootstrap,expected:executorExpected,releasePath:join(stage,'release-'+c.runId+'.json'),acceptedPath:join(stage,'gate-'+c.runId,'release-accepted.json')}};
  validatePlan(bootPlan);write(join(stage,'bootstrap.reviewed.json'),bootPlan);
  bridgeTask=serveBridge(bridge,c,gateIdentity,async row=>{
   socketGuard(c);const nativeCheckpoint=await episode.check('cmux');
   if(row.phase==='result'){const file=privateJSON(join(stage,'receipt-'+c.runId,'result.json'));check(row.detail.resultSHA256===file.sha256,'actual result bytes mismatch');outcome=file.value;bootPeer=row.peer;}
   if(row.phase==='before-runner'||row.phase==='after-runner'||(row.phase==='result'&&outcome.caseCreateAttempts===1)){
    ownedCase=readCaseOwnership(stage,c);
   }
   if(row.phase==='result')return {nativeCheckpoint};
   if(row.phase==='before-create')result.admitted=1;
   let current;if(row.phase==='before-runner'){current=await readSelected(checkedBackend);check([ownedBootstrap.workspaceId,ownedCase.workspaceId].includes(current.topology.workspaceId),'foreign selection before runner');expected=current.topology;}else current=await readSelected(checkedBackend,expected);
   const last=await episode.check('cmux');return {nativeCheckpoint:last,protocolTopology:current.topology};
  },record,{signal:bridgeAbort.signal}).catch(error=>{bridgeFailure=error;return null;});
  const release={contract:'TERMINAL_INITIAL_COMMAND_RELEASE',releaseCount:1,runId:c.runId,dispatchId:c.coordinationReceipt.dispatchId,threadId:c.coordinationReceipt.threadId,nonce:bridge.nonce,gateIdentity,gateACKSHA256:gate.sha256,configSHA256:gate.value.configSHA256,planSHA256:hash(join(stage,'bootstrap.reviewed.json')),workspaceId:ownedBootstrap.workspaceId,surfaceId:bootstrap.anchorSurfaceId,creationACKSHA256:executorExpected.creationACKSHA256,topologySHA256:executorExpected.topologySHA256,deadlineUTC:c.deadlineUTC,releasedUTC:new Date().toISOString()};
  await episode.check('cmux');await readSelected(checkedBackend,expected);write(bootPlan.executorWitness.releasePath,release);releasePublished=true;record('single-release',release);result.releaseRequests=1;
  await bridgeTask;if(bridgeFailure)throw bridgeFailure;check(outcome,'boot result unavailable');result.executed=outcome.runnerSpawnAttempts===1?1:0;
  const gateExit=await waitFile(join(stage,'gate-'+c.runId,'exit.json'),Date.parse(c.deadlineUTC)-15000);record('actual-gate-exit',gateExit.value);
  const inventory=readOwnedInventory(stage,c,outcome,gateIdentity);const rows=inventory.rows;
  if(outcome.runnerSpawnAttempts===1){const rr=privateJSON(join(c.root,'result.json')).value;result.caseResult=rr;result.passed=rr.status==='CASE_PASS_RESTORATION_PENDING'?1:0;result.failed=1-result.passed;}
  const processes=await cleanupProcesses(rows,Date.parse(c.deadlineUTC)-10000);if(!inventory.complete){processes.status='UNKNOWN_RETAINED';processes.inventoryError=inventory.error;}record('owned-processes',processes);
  const cleanupBackend=new Proxy(backend,{get(target,key){const fn=target[key];return typeof fn==='function'? (...args)=>boundedCleanup(c,String(key),()=>fn.apply(target,args),record):fn;}});
  restorationAttempted=true;result.restoration=await restoreAndClose({episode,backend:cleanupBackend,baseline,expected,ownedCase,ownedBootstrap,processes,deadline:Date.parse(c.deadlineUTC)-3000},{record});
  result.status=result.passed===1&&result.restoration.cmux.status==='RESTORED'&&result.restoration.original.status==='RESTORED'&&result.restoration.bootstrapClosure.status==='CLOSED_ACK_OWNED'?'CASE_AND_RESTORATION_OBSERVED':'UNPROVED';
 }catch(error){
  result.error=String(error);result.status='UNKNOWN_RETAINED';
  try{
   if(!gate&&fs.existsSync(join(stage,'gate-'+c.runId,'start.json')))gate=privateJSON(join(stage,'gate-'+c.runId,'start.json'));
   if(gate&&!gateIdentity){const w=gate.value,live=queryProcess(w.identity.pid,1000);check(w.runId===c.runId&&w.dispatchId===c.coordinationReceipt.dispatchId&&w.threadId===c.coordinationReceipt.threadId&&w.nonce===bridge.nonce&&w.configSHA256===hash(join(stage,'gate-config.json'))&&w.gateSHA256===p.sourcePins['bootstrap-gate.mjs']&&sameProcess(w.identity,live),'own gate failure cleanup identity unproved');ancestry(c,live.pid,queryProcess);gateIdentity=live;}
   if(!outcome&&fs.existsSync(join(stage,'receipt-'+c.runId,'result.json')))outcome=privateJSON(join(stage,'receipt-'+c.runId,'result.json')).value;
   let caseOwnershipError;try{if(!ownedCase&&outcome?.caseCreateAttempts===1)ownedCase=readCaseOwnership(stage,c);}catch(e){caseOwnershipError=String(e);result.caseOwnershipError=caseOwnershipError;}
   result.executed=outcome?.runnerSpawnAttempts===1?1:(releasePublished&&!outcome?null:0);
   const inventory=readOwnedInventory(stage,c,outcome,gateIdentity,{releasePublished,bootstrapCreated:Boolean(ownedBootstrap)});const processes=await cleanupProcesses(inventory.rows,Date.parse(c.deadlineUTC)-3000);if(!inventory.complete||caseOwnershipError||(!outcome&&releasePublished)){processes.status='UNKNOWN_RETAINED';processes.inventoryError=inventory.error||caseOwnershipError||'CASE effects unknown';}record('failure-owned-processes',processes);
   if(!restorationAttempted&&ownedBootstrap&&baseline&&expected){restorationAttempted=true;
    const cleanupBackend=new Proxy(backend,{get(target,key){const fn=target[key];return typeof fn==='function'? (...args)=>boundedCleanup(c,'failure-'+String(key),()=>fn.apply(target,args),record):fn;}});
    result.restoration=await restoreAndClose({episode,backend:cleanupBackend,baseline,expected,ownedCase,ownedBootstrap,processes,deadline:Date.parse(c.deadlineUTC)-3000},{record});
   }
  }catch(cleanupError){result.failureCleanupError=String(cleanupError);}
 }

 finally{bridgeAbort.abort();if(bridgeTask)await bridgeTask;try{await episode.finish();}catch(e){result.helperLifecycleError=String(e);}result.helperLifecycle={ended:episode.ended,exit:episode.exit??null};result.cmuxNative=result.restoration?.cmux.status??'UNPROVED';result.originalNative=result.restoration?.original.status??'UNPROVED';if(result.status==='CASE_AND_RESTORATION_OBSERVED'&&(!episode.ended||result.helperLifecycleError))result.status='UNPROVED';backend.disconnect();result.END_RETURN=new Date().toISOString();if(fs.existsSync(episode.c.receiptDir))record('episode-result',result);}
 return result;
}
function readCaseOwnership(stage,c){const receipts=join(stage,'receipt-'+c.runId);return bindCreation(privateJSON(join(receipts,'pre-case-baseline.json')).value.workspaces,privateJSON(join(receipts,'case-creation-ack.json')).value,privateJSON(join(receipts,'case-creation-observation.json')).value,c.marker);}
export function readOwnedInventory(stage,c,outcome,gateIdentity,{releasePublished=true,bootstrapCreated=true}={}) {
 const rows=[],errors=[];let rr;
 const add=(path)=>{try{return privateJSON(path).value;}catch(e){errors.push(String(e));return null;}};
 if(outcome?.runnerSpawnAttempts===1||fs.existsSync(join(stage,'receipt-'+c.runId,'runner-spawn-attempt.json'))){
  rr=add(join(c.root,'result.json'));const launch=add(join(c.root,'launch.json'));
  if(!rr?.daemon_creation_ack||!rr?.proxy_creation_ack||!launch?.child||!launch?.parent)errors.push('owned child creation inventory incomplete');
  const priorStop=fs.existsSync(join(stage,'receipt-'+c.runId,'runner-deadline-stop.json'))?add(join(stage,'receipt-'+c.runId,'runner-deadline-stop.json')):null;
  for(const identity of [launch?.child,launch?.parent,add(join(c.root,'proxy-identity.json')),add(join(c.root,'daemon-identity.json')),add(join(stage,'receipt-'+c.runId,'runner-identity.json'))].filter(Boolean))rows.push({identity,stopAlreadyRequested:(priorStop?.identity&&sameProcess(priorStop.identity,identity))||(rr?.cleanup??[]).some(r=>r.signal_requested===true&&sameProcess(r.identity,identity))});
 }else if(releasePublished&&outcome?.runnerSpawnAttempts!==0)errors.push('runner creation effects unknown');
 const gateExitPath=join(stage,'gate-'+c.runId,'exit.json'),bootIdentityPath=join(stage,'gate-'+c.runId,'boot-child-identity.json');
 if(fs.existsSync(bootIdentityPath)){const identity=add(bootIdentityPath);if(identity){const stop=fs.existsSync(join(stage,'gate-'+c.runId,'boot-deadline-stop.json'))?add(join(stage,'gate-'+c.runId,'boot-deadline-stop.json')):null;rows.push({identity,stopAlreadyRequested:stop?.requested===true&&sameProcess(stop.identity,identity)});}}
 else if(releasePublished){const exit=fs.existsSync(gateExitPath)?add(gateExitPath):null;if(exit?.bootSpawnAttempts!==0)errors.push('boot child creation identity unknown');}
 if(gateIdentity)rows.push({identity:gateIdentity});else if(releasePublished||bootstrapCreated)errors.push('gate identity unknown; foreground job absence unproved');
 return {rows,complete:errors.length===0,error:errors.join('; ')};
}
async function boundedCleanup(c,label,operation,record){socketGuard(c);const ms=Math.min(2000,Date.parse(c.deadlineUTC)-Date.now()-3000);check(ms>0,'cleanup absolute reserve');let timer;try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,j)=>{timer=setTimeout(()=>{record('cleanup-unknown-'+Date.now(),{label,effects:'UNKNOWN',replay:false});j(Error('cleanup RPC deadline'));},ms);})]);}finally{clearTimeout(timer);}}
if(process.argv[1]&&resolve(process.argv[1])===self){const p=privateJSON(join(stage,'episode.reviewed.json')).value;const result=await executeEpisode(p);console.log(JSON.stringify({status:result.status,END_RETURN:result.END_RETURN,acceptedCaseWitness:result.status==='CASE_AND_RESTORATION_OBSERVED'}));if(result.status!=='CASE_AND_RESTORATION_OBSERVED')process.exitCode=2;}
