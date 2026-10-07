import { mkdirSync, writeFileSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { shellQuote } from "./target.mjs";
import { sealFixtureInstall, attestFixtureInstall } from "./fixture-attestation.mjs";

export function fixtureLaunchArgs(cli, args) {
  if (!["codex", "claude"].includes(cli)) throw new Error("fixture CLI unsupported");
  const argv = []; let worker = false, cwd;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = () => { if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error("fixture flag value missing"); return args[++i]; };
    if (arg === "--worker") worker = true;
    else if (arg === "-s") continue;
    else if (arg === "-w" || arg === "--worktree") { cwd = value(); if (!cwd.startsWith("/")) throw new Error("fixture cwd must be absolute"); }
    else if (arg === "-m" || arg === "--model") { const model = value(); if (model !== (cli === "codex" ? "gpt-6-luna" : "haiku")) throw new Error("fixture model metadata mismatch"); argv.push("--model", model); }
    else if (arg === "-E") { const effort = value(); if (effort !== "low") throw new Error("fixture effort metadata mismatch"); argv.push("-c", "model_reasoning_effort=low"); }
    else argv.push(arg);
  }
  if (worker && cli === "codex") argv.push("-c", "features.apps=false", "-c", "apps._default.enabled=false");
  return { cwd, argv, worker };
}

export function installFixtureLaunchers(env, opts, scratch, cwd) {
  const root = realpathSync(scratch), bin = join(root, "bin");
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(opts.repo ?? "")) throw new Error("fixture registry prefix invalid");
  if (!realpathSync(cwd).startsWith(root + "/")) throw new Error("fixture cwd escapes scratch");
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|ANTHROPIC_|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)/.test(key)) delete env[key];
    else if (typeof env[key] === "string") env[key] = env[key].replaceAll(scratch + "/", root + "/");
  }
  mkdirSync(bin, { mode: 0o700 });
  const source = fileURLToPath(import.meta.url), tui = fileURLToPath(new URL("../ratchet-fixture-tui.mjs", import.meta.url));
  const row = opts.fixtureRow;
  if (row && !["banner", "boot", "contract"].includes(row)) throw new Error("ratchet fixture row unsupported");
  const launchers = Object.fromEntries(["codex", "claude"].map(cli => [cli, opts.repo + (cli === "codex" ? "Codex" : "Claude")]));
  const fixtureBinaries = Object.fromEntries(["codex", "claude"].map(cli => {
    const path = join(bin, cli);
    writeFileSync(path, row ? `#!/bin/sh\nprintf '%s\\n' ${shellQuote(cli)} >> ${shellQuote(join(root, "model-trap.log"))}\nexit 86\n` :
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(source)} native ${cli} "$@"\n`, { mode: 0o700 });
    return [cli, path];
  }));
  env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = join(root, "fixture-launchers.zsh");
  env.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY = "1";
  env.CMUXLAYER_FIXTURE_MANIFEST = join(root, "fixture-manifest.json");
  env.CMUXLAYER_SESSION_REGISTRY = join(root, "fixture-sessions.jsonl");
  env.CMUXLAYER_XMAC_FIXTURE_DIR = root;
  env.CMUXLAYER_XMAC_LEAD_CONFIG = join(root, "private-mcp.json");
  env.CMUX_CUSTOM_CODEX_PATH = fixtureBinaries.codex;
  env.CMUX_CUSTOM_CLAUDE_PATH = fixtureBinaries.claude;
  // There is no native model CLI on the fallback PATH. The installed Codex
  // wrapper can delegate only to the private fixture via its supported override.
  env.PATH = [...(row ? [] : [join(opts.app, "Contents/Resources/bin")]), bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const bundleWrapper = join(opts.app, "Contents/Resources/bin/codex");
  try {
    if (row) throw Object.assign(new Error("ratchet uses private traps"), { code: "ENOENT" });
    if (!readFileSync(realpathSync(bundleWrapper), "utf8").includes("CMUX_CUSTOM_CODEX_PATH")) throw new Error("bundle wrapper fixture delegation unsupported");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const functions = Object.entries(launchers).map(([cli, name]) => `${name}() { ${shellQuote(process.execPath)} ${shellQuote(source)} launcher ${cli} "$@"; }`).join("\n");
  writeFileSync(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH, `repoGolem ${opts.repo} ${shellQuote(realpathSync(cwd))}\n${functions}\n`, { mode: 0o600 });
  const receipt = sealFixtureInstall({ status: "PASS", fixture_only: true, root, tui, row,
    events: join(root, "ratchet-events.json"), binaries: fixtureBinaries, launchers,
    hashes: Object.fromEntries(Object.entries(fixtureBinaries).map(([cli, path]) => [cli, digest(path)])) }, env, source);
  writeFileSync(env.CMUXLAYER_FIXTURE_MANIFEST, JSON.stringify(receipt), { mode: 0o600 });
  return receipt;
}
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
export function verifyFixtureLaunchers(receipt, env) {
  if (receipt?.fixture_only !== true || realpathSync(receipt.root) !== receipt.root ||
      Object.keys(receipt.binaries ?? {}).sort().join(",") !== "claude,codex") throw new Error("fixture installation missing");
  for (const [cli, path] of Object.entries(receipt.binaries)) {
    const stat = lstatSync(path);
    if (path !== join(receipt.root, "bin", cli) || !stat.isFile() || stat.isSymbolicLink() ||
        stat.uid !== process.getuid() || stat.mode & 0o077 || !(stat.mode & 0o100) || digest(path) !== receipt.hashes[cli]) throw new Error("fixture binary identity changed");
  }
  attestFixtureInstall(receipt, env);
}

async function main() {
  const [mode, cli, ...args] = process.argv.slice(2);
  if (!process.env.CMUXLAYER_XMAC_FIXTURE_DIR || !["native", "launcher"].includes(mode)) throw new Error("fixture routing missing");
  const manifest = JSON.parse(readFileSync(process.env.CMUXLAYER_FIXTURE_MANIFEST, "utf8"));
  verifyFixtureLaunchers(manifest, process.env);
  if (mode === "native" && args[0] === "debug" && args[1] === "models") { console.log(JSON.stringify({ models: ["gpt-6-luna"], fixture: true })); return; }
  if (args.includes("--xmac-preflight")) { console.log(JSON.stringify({ fixture: true, cli, executable: fileURLToPath(import.meta.url) })); return; }
  const parsed = mode === "launcher" ? fixtureLaunchArgs(cli, args) : { argv: args };
  const root = realpathSync(process.env.CMUXLAYER_XMAC_FIXTURE_DIR), cwd = realpathSync(parsed.cwd ?? process.cwd());
  if (cwd !== root && !cwd.startsWith(root + "/")) throw new Error("fixture launch cwd escapes scratch");
  if (manifest.row && (mode !== "launcher" || cli !== "codex")) throw new Error("ratchet fixture launcher mismatch");
  const child = spawn(process.execPath, manifest.row ? [manifest.tui, manifest.row, manifest.events] :
    [manifest.tui, `xmac-${cli}`, "unused", ...parsed.argv],
    { cwd, env: process.env, stdio: "inherit" });
  // A recorded child only; never a pattern killer or a native-CLI fallback.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
