import { expect, it } from "vitest";
import { admissionStages, admitAppStart } from "../scripts/xmac/app-admission.mjs";
import { readFileSync } from "node:fs";

function lifecycle(bad?: string) {
  const calls:string[]=[], effects:string[]=[];
  const adapter:any=Object.fromEntries(admissionStages.map((stage:string)=>[stage,async()=>{
    calls.push(stage); if(stage===bad)throw Error(`invalid ${stage}`);
  }]));
  adapter.refreshAndQuit=async()=>{ calls.push("refresh PID/start");effects.push("quit"); };
  adapter.launch=async()=>{effects.push("launch");return {settle:()=>effects.push("settle"),close:()=>effects.push("normal-close")};};
  return {adapter,calls,effects};
}
it.each(["app","dmg","fixture","environment","preferences","config","shell","lock"])("bad %s admits zero quit/launch calls",async bad=>{
  const f=lifecycle(bad);
  await expect(admitAppStart(f.adapter)).rejects.toThrow(`invalid ${bad}`);
  expect(f.effects).toEqual([]);expect(f.calls).not.toContain("refresh PID/start");
});
it("requires a complete adapter before even acquiring its lock",async()=>{
  const f=lifecycle();delete f.adapter.preferences;
  await expect(admitAppStart(f.adapter)).rejects.toThrow(/stage missing/);
  expect(f.calls).toEqual([]);expect(f.effects).toEqual([]);
});
it("refreshes approval after all admission checks, then retains settle and normal close",async()=>{
  const f=lifecycle(), result=await admitAppStart(f.adapter);result.settle();result.close();
  expect(f.calls).toEqual([...admissionStages,"refresh PID/start"]);
  expect(f.effects).toEqual(["quit","launch","settle","normal-close"]);
});
it("native lifecycle uses the admitted adapter with every actual boundary",()=>{
  const source=readFileSync(new URL("../scripts/soak-runtime.mjs",import.meta.url),"utf8");
  const body=source.slice(source.indexOf("await admitAppStart({"),source.indexOf("const deadline = Date.now() + 10_000"));
  expect(body).toContain("assertAppTarget");expect(body).toContain("PINNED_DMG_SHA256");
  expect(body).toContain("privateBuild");expect(body).toContain("installFixtureLaunchers");
  expect(body).toContain("verifyFixtureLaunchers");expect(body).toContain("verifyFixtureShell");
  expect(body).toContain("verifyClosePreferences");expect(body).toContain("acquireNightlyLock");
  expect(body.indexOf("verifyClosePreferences")).toBeLessThan(body.indexOf("await prepareM1AppMutation"));
  expect(body.indexOf("await prepareM1AppMutation")).toBeLessThan(body.indexOf('run("/usr/bin/open"'));
});
