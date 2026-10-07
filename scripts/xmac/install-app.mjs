#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { guardedM1AppReplacement, prepareM1AppMutation } from "../soak-runtime.mjs";
import { humanSessionApprovalArgument } from "../cmux-session-guard.mjs";

// Execute on the designated M1 only. Verification is read-only; every bundle
// rename (including rollback) is guarded. Never swap a bundle beneath a live app.
export async function installApp(opts) {
  const app = "/Applications/cmux.app", receipt = { operation: "install", launch_token: randomUUID(), processes: [], status: "FAIL" };
  let stage, moved = false;
  try {
    await prepareM1AppMutation(opts, receipt, "replace");
    for (const key of ["source", "backup", "receipt"]) if (!opts[key]?.startsWith("/")) throw new Error(`absolute ${key} path required`);
    if (opts.source === app || existsSync(opts.backup)) throw new Error("source is installed app or backup already exists");
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", opts.source]);
    execFileSync("/usr/sbin/spctl", ["-a", "-vv", opts.source]);
    const plist = key => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(opts.source, "Contents/Info.plist")], { encoding: "utf8" }).trim();
    if (plist("CFBundleIdentifier") !== "com.cmuxterm.app") throw new Error("source bundle identity mismatch");
    receipt.source = { path: opts.source, version: plist("CFBundleShortVersionString") };
    stage = mkdtempSync("/Applications/.cmux-xmac-install-");
    execFileSync("/usr/bin/ditto", [opts.source, join(stage, "cmux.app")]);
    // Approval has already been applied, so subsequent guards cannot quit again.
    const swap = { ...opts, humanSessionQuitApproved: undefined };
    await guardedM1AppReplacement(swap, receipt, () => { renameSync(app, opts.backup); moved = true; });
    await guardedM1AppReplacement(swap, receipt, () => renameSync(join(stage, "cmux.app"), app));
    receipt.status = "PASS"; receipt.backup = opts.backup;
  } catch (error) {
    receipt.error = String(error); receipt.precondition = error.precondition;
    if (moved && !existsSync(app)) {
      try { await guardedM1AppReplacement({ ...opts, humanSessionQuitApproved: undefined }, receipt, () => renameSync(opts.backup, app)); }
      catch (rollback) { receipt.rollback_error = String(rollback); }
    }
    throw error;
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (opts.receipt?.startsWith("/")) { mkdirSync(dirname(opts.receipt), { recursive: true, mode: 0o700 }); writeFileSync(opts.receipt, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); }
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = { gateHost: "Locals-MacBook-Pro.local" }, names = { "--source": "source", "--backup": "backup", "--receipt": "receipt" };
  try {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      if (humanSessionApprovalArgument(argv[i], opts)) continue;
      if (!names[argv[i]] || !argv[i + 1]) throw new Error("source, backup and receipt arguments required");
      opts[names[argv[i]]] = argv[++i];
    }
    await installApp(opts);
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
