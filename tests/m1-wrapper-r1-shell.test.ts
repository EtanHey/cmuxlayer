import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as runtime from "../scripts/soak-runtime.mjs";
import { installFixtureLaunchers } from "../scripts/xmac/fixture-launchers.mjs";
import { shellQuote } from "../scripts/xmac/target.mjs";
import { verifyFixtureShell } from "../scripts/xmac/fixture-shell.mjs";

function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"m1-r1-shell-")));
  for(const dir of ["home","zdot","repo"]) mkdirSync(join(root,dir),{mode:0o700});
  const env:any={HOME:join(root,"home"),ZDOTDIR:join(root,"zdot"),LC_ALL:"C"};
  const install=installFixtureLaunchers(env,{repo:"ratchet",fixtureRow:"contract",app:"/absent"},root,join(root,"repo"));
  const opts={fixtureMode:true,target:"m1-gate",launcherMode:true,launchCwd:join(root,"repo"),launchers:install.launchers,launchReceipt:join(root,"launches.jsonl")};
  if((runtime as any).writeShellStartup) (runtime as any).writeShellStartup(env,opts);
  else writeFileSync(join(env.ZDOTDIR,".zshenv"),runtime.shellStartup(env,opts),{mode:0o600});
  return {root,env,install};
}
it.each(["native-anchor","startup-probe"])("keeps exact private routing on the actual %s login leg",leg=>{
  const f=fixture(), marker="R1_RESOLUTION:";
  const command=`printf '\\n${marker}%s\\n' "$(command -v codex)"; ${shellQuote(process.execPath)} ${shellQuote(f.install.attestation.files.helper.path)} launcher codex --xmac-preflight`;
  const result=leg==="native-anchor" ? spawnSync("/usr/bin/python3",[new URL("./fixtures/m1-login-shell.py",import.meta.url).pathname,JSON.stringify(f.env),join(f.root,"repo"),command],{encoding:"utf8"}) :
    spawnSync("/bin/zsh",["-lc",command],{env:f.env,cwd:join(f.root,"repo"),encoding:"utf8"});
  expect(result.status,result.stderr).toBe(0);
  const screen=leg==="native-anchor" ? JSON.parse(result.stdout).screen : result.stdout;
  const resolved=screen.split(/\r?\n/).find((s:string)=>s.startsWith(marker))?.slice(marker.length).trim();
  expect(resolved,screen).toBe(f.install.binaries.codex);
  expect(screen).toContain('"fixture":true'); expect(screen).not.toContain("routing changed");
  expect(existsSync(join(f.root,"model-trap.log"))).toBe(false);
});
it("rejects any foreign absolute codex resolution before effects",()=>{
  const f=fixture(), valid=JSON.stringify({fixture:true,cli:"codex",executable:f.install.attestation.files.helper.path});
  expect(()=>verifyFixtureShell(f.install,f.env,()=>`${f.install.binaries.codex}\n${valid}\n`)).not.toThrow();
  expect(()=>verifyFixtureShell(f.install,f.env,()=>`/synthetic/foreign/codex\n${valid}\n`)).toThrow(/resolution changed/);
});
it("attests the actual login-shell helper environment before app admission",()=>{
  const f=fixture();
  expect(verifyFixtureShell(f.install,f.env).resolved).toBe(f.install.binaries.codex);
  expect(()=>verifyFixtureShell(f.install,{...f.env,CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY:"0"})).toThrow(/routing changed/);
});
it("keeps the actual anchor and startup probe on the tested login shell legs",()=>{
  expect(readFileSync(new URL("../scripts/soak-runtime.mjs",import.meta.url),"utf8")).toContain(': "/bin/zsh -l"');
  expect(readFileSync(new URL("../scripts/xmac/startup-probe.mjs",import.meta.url),"utf8")).toContain('initial_command: `/bin/zsh -lc');
});
