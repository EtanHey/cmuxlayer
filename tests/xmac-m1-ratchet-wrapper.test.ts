import { expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const modulePath = process.env.M1_WRAPPER_UNDER_TEST ?? new URL("../scripts/xmac/m1-ratchet.mjs", import.meta.url).href;
const { rows, validateWrapperConfig, evaluateRow, combineProof, checkProductRegistry, requiredRunnerFiles } = await import(modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href);
const candidate="288dadb4c48a69af63a8151970d3c01d448746a2";
const row={name:"spawn_contract_once",fixture:"contract"};
const result={ok:true,agent_id:"fixture",contract_path:"/private/contract.md",boot_prompt_delivered:true,boot_prompt_submit_verified:true,coordination_footer_delivered:true,spawn_state:"running"};
const expected="TOKEN ; cmuxlayer contract for fixture: Read and follow /private/contract.md";
const event={submitted:expected,submissions:[expected],draft:"",keys:["Return"],phase:"working"};
const evaluate=(e=event,r=result)=>evaluateRow(row,"TOKEN",r,e,{text:"Working"});
it("retains original banner/boot source pairs alongside exact approved contract pair",()=>{
 expect(rows.map((r:any)=>r.name)).toEqual(["send_under_codex_banner","spawn_boot_false_unsubmitted","spawn_contract_once"]);
 expect(rows[2]).toMatchObject({bug:"87eccd87a81d116e3fe6056a9373e7d85fd0c3ab",fix:candidate});
});
it("requires one exact combined entry with empty draft and verified boot/footer",()=>{
 expect(evaluate()).toMatchObject({behavior_status:"PASS",contract_once:true});
});
for(const [fault,change] of Object.entries({extraReturn:{keys:["Return","Return"]},LF:{keys:["Return","LF"]},doubleEntry:{submissions:[expected,expected]},draft:{draft:"foreign"},wrongText:{submitted:"TOKEN"}}))
 it(`rejects ${fault} native row evidence`,()=>expect(evaluate({...event,...change})).toMatchObject({behavior_status:"FAIL"}));
it("requires footer and boot acknowledgments separately",()=>{
 expect(evaluate(event,{...result,coordination_footer_delivered:false})).toMatchObject({behavior_status:"FAIL"});
 expect(evaluate(event,{...result,boot_prompt_submit_verified:false})).toMatchObject({behavior_status:"FAIL"});
});
it("records exact stranded-footer baseline defect without confusing infrastructure failure",()=>{
 const r=evaluateRow(row,"TOKEN",{...result,spawn_state:"boot_unsubmitted",boot_prompt_delivered:false},
 {...event,submitted:"TOKEN",submissions:["TOKEN"],draft:"cmuxlayer contract for fixture: Read and follow /private/contract.md"},{text:"Working"});
 expect(r).toMatchObject({behavior_status:"FAIL",expected_defect:true});
 expect(evaluateRow(row,"TOKEN",result,null,null)).toMatchObject({behavior_status:"FAIL",expected_defect:false});
});
it("keeps behavior PASS distinct from overall marker FAIL and demands RED witness",()=>{
 const b={behavior_status:"FAIL",expected_defect:true,attribution_status:"PASS"};
 const c={behavior_status:"PASS",attribution_status:"FAIL"};
 expect(combineProof(b,c)).toMatchObject({behavior_status:"PASS",status:"FAIL"});
 expect(combineProof({...b,expected_defect:false},{...c,attribution_status:"PASS"})).toMatchObject({status:"FAIL"});
});
it("rejects unapproved product, runner identity collapse, missing controls and non-M1 routes",()=>{
 const cfg={nativeApproved:true,accountContract:"dedicated-test-502-v1",runnerSha:"a".repeat(40),runnerFiles:Object.fromEntries((requiredRunnerFiles ?? []).map((f:string)=>[f,"a".repeat(64)])),products:Object.fromEntries(rows.map((r:any)=>[r.name,{baseline:{sha:r.bug,distDigest:"c".repeat(64)},candidate:{sha:r.fix,distDigest:"d".repeat(64)}}]))};
 expect(()=>validateWrapperConfig(cfg)).not.toThrow();
 expect(()=>validateWrapperConfig({...cfg,accountContract:undefined})).toThrow();
 expect(()=>validateWrapperConfig({...cfg,options:{humanSessionQuitApproved:"77:exact"}})).toThrow();
 for(const copy of [{...cfg,nativeApproved:false},{...cfg,runnerSha:candidate},{...cfg,host:"mbp"},
  {...cfg,products:{}},{...cfg,products:{...cfg.products,spawn_contract_once:{baseline:{sha:rows[2]?.bug},candidate:{sha:"b58063f4028c22828fb340ea03750f153a959a87"}}}}])
  expect(()=>validateWrapperConfig(copy)).toThrow();
});

it("checks compiled registry enforcement against a raw-plan sensitivity control without executing a model",()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"m1-resolver-probe-")));
 try {
  mkdirSync(join(root,"dist/engine"),{recursive:true});
  const file=join(root,"dist/engine/launch-command.js");
  const env={HOME:root,CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY:"1",CMUXLAYER_LAUNCHER_REGISTRY_PATH:join(root,"missing")};
  writeFileSync(file,"export const launcherRegistryRequired=e=>e.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY==='1'; export function resolveSpawnLaunchPlan(r,c,o){if(launcherRegistryRequired(o.env))throw Error('Launcher registry missing');return {launchMode:'raw'};} ");
  expect(()=>checkProductRegistry({root},env)).not.toThrow();
  writeFileSync(file,"export const launcherRegistryRequired=e=>true; export const resolveSpawnLaunchPlan=()=>({launchMode:'raw'});");
  expect(()=>checkProductRegistry({root},env)).toThrow();
  writeFileSync(file,"export const launcherRegistryRequired=e=>true; export const resolveSpawnLaunchPlan=()=>{throw Error('Cannot resolve cwd');};");
  expect(()=>checkProductRegistry({root},env)).toThrow();
 } finally {rmSync(root,{recursive:true,force:true});}
});

it("refuses missing compiled/source hash bindings before native admission",()=>{
 const products=Object.fromEntries(rows.map((r:any)=>[r.name,{baseline:{sha:r.bug,distDigest:"c".repeat(64)},candidate:{sha:r.fix,distDigest:"d".repeat(64)}}]));
 const cfg={nativeApproved:true,runnerSha:"a".repeat(40),products,runnerFiles:Object.fromEntries((requiredRunnerFiles ?? []).map((f:string)=>[f,"a".repeat(64)]))};
 expect(()=>validateWrapperConfig({...cfg,runnerFiles:{}})).toThrow();
 const copy=structuredClone(cfg); delete copy.products.spawn_contract_once.candidate.distDigest;
 expect(()=>validateWrapperConfig(copy)).toThrow();
});
