import { expect, it } from "vitest";
import { installFixtureLaunchers } from "../scripts/xmac/fixture-launchers.mjs";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
function run(mode = "folded", fault = "none") {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "m1-ratchet-pty-")));
 try {
  mkdirSync(join(root,"repo"));
  const env: any = { ...process.env, HOME: root };
  installFixtureLaunchers(env, { repo:"ratchet",app:"/absent/app",fixtureRow:"contract" },root,join(root,"repo"));
  return JSON.parse(execFileSync("/usr/bin/python3", ["tests/fixtures/m1-ratchet-pty.py",process.execPath,process.cwd(),env.CMUXLAYER_FIXTURE_MANIFEST,mode,fault], {env,encoding:"utf8",timeout:15000}));
 } finally { rmSync(root,{recursive:true,force:true}); }
}
it("submits one folded entry through the real private launcher/PTY with actual process binding",()=>{
 const r=run(); expect(r.first.phase).toBe("initializing");
 expect(r.state.submissions).toEqual(["FIXTURE_TOKEN ; cmuxlayer contract for fixture: Read and follow /private/fixture/contract.md"]);
 expect(r.state.draft).toBe(""); expect(r.state.keys).toEqual(["Return"]);
 expect(r.witness.ok).toBe(true); expect(r.witness.observed.pid).toBe(r.state.pid);
 expect(r.witness.observed.start).toBeTruthy(); expect(r.screen).toContain("Working");
});
it("retains the split-input defect as an observed token submission with stranded footer",()=>{
 const r=run("split"); expect(r.state.submitted).toBe("FIXTURE_TOKEN");
 expect(r.state.draft).toBe("cmuxlayer contract for fixture: Read and follow /private/fixture/contract.md");
 expect(r.state.keys).toEqual(["LF","LF"]); expect(r.witness.ok).toBe(true);
});
for(const fault of ["pid","surface","argv","row","start","registry"])
 it(`refuses ${fault} binding drift at the observed real PTY boundary`,()=>{
  const r=run("folded",fault); expect(r.witness.ok).toBe(false); expect(r.witness.error).toMatch(/identity|binding|registry/i);
 });
