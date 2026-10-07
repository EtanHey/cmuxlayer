import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { productionSnapshot, productionChanges } from "../scripts/xmac/production-guard.mjs";
import { bindAccountHome, accountProductionSnapshot } from "../scripts/xmac/account-home.mjs";

it("observes modeled account markers despite a private caller HOME",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"m1-r1-account-"))), account=join(root,"account"), caller=join(root,"caller");
  for(const h of [account,caller]) mkdirSync(join(h,".local/state/cmux"),{recursive:true,mode:0o700});
  const path=new URL("../scripts/xmac/account-home.mjs",import.meta.url), api:any=existsSync(path)?await import(path.href):null;
  const old=process.env.HOME; process.env.HOME=caller;
  try {
    const deps={info:()=>({...userInfo(),homedir:account})};
    // Explicit legacy observer adapter for the immutable RED: caller-sensitive homedir.
    const binding=api?api.bindAccountHome(deps):{home:homedir()};
    const snapshot=()=>api?api.accountProductionSnapshot(binding,deps):productionSnapshot(binding.home);
    const before=snapshot(), socket="/tmp/cmux-soak-stable.sock";
    writeFileSync(join(account,".local/state/cmux/last-socket-path"),socket+"\n",{mode:0o600});
    writeFileSync(join(account,".local/state/cmux/nightly-last-socket-path"),"/tmp/cmux-nightly.sock\n",{mode:0o600});
    writeFileSync(join(account,".local/state/cmux/cmuxlayer-daemon-modeled.log"),"R1_OWNED_MARKER\n",{mode:0o600});
    const after=snapshot();
    expect(productionChanges(before,after,[socket,"R1_OWNED_MARKER"],[])).toEqual([
      ".local/state/cmux/cmuxlayer-daemon-modeled.log",".local/state/cmux/last-socket-path",".local/state/cmux/nightly-last-socket-path"]);
    expect(after.account_home).toMatchObject({home:account,source:"os.userInfo"});
  } finally { if(old===undefined)delete process.env.HOME;else process.env.HOME=old; }
});
it("uses independent account lookup in a real Node process with caller HOME changed",()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"m1-r1-home-env-")));
  const code=`import {bindAccountHome} from ${JSON.stringify(new URL("../scripts/xmac/account-home.mjs",import.meta.url).href)}; console.log(JSON.stringify(bindAccountHome()));`;
  const result=spawnSync(process.execPath,["--input-type=module","-e",code],{env:{HOME:root},encoding:"utf8"});
  expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout).home).toBe(realpathSync(userInfo().homedir));
  expect(JSON.parse(result.stdout).home).not.toBe(root);
});
it("refuses account UID, inode or canonical HOME drift before another snapshot",()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"m1-r1-home-identity-")));
  const info=()=>({...userInfo(),homedir:root}), binding=bindAccountHome({info});
  expect(()=>accountProductionSnapshot({...binding,ino:binding.ino+1},{info})).toThrow(/identity changed/);
  expect(()=>bindAccountHome({info:()=>({...info(),uid:info().uid+1})})).toThrow(/identity invalid/);
});
it("carries one account identity through every wrapper snapshot including errors",()=>{
  const source=readFileSync(new URL("../scripts/xmac/m1-ratchet.mjs",import.meta.url),"utf8");
  expect(source).not.toContain("productionSnapshot(homedir())");
  expect(source).toContain("const accountHome = bindAccountHome()");
  expect(source).toContain("production_before: before");expect(source).toContain("account_home: accountHome, before, after");
  expect(source).toContain("account_home: accountHome, before: productionBefore, after: productionAfter");
});
