import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { targetOptions, shellQuote } from "./target.mjs";

const NODE = "/opt/homebrew/opt/node/bin/node";
export function targetCommand(opts, command, args = []) {
  targetOptions(opts); // Refuse the controller's production target before ANY SSH/build.
  return opts.host === "m1" ? { command: "ssh", args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "m1", [command, ...args].map(shellQuote).join(" ")] }
    : { command, args };
}
export function connectProcess(child, timeoutMs = 120_000) {
  let sequence = 0, closed = false;
  const pending = new Map();
  const fail = error => { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line), item = pending.get(message.id);
      if (!item) throw new Error("unexpected target response id");
      clearTimeout(item.timer); pending.delete(message.id);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
    } catch (error) { fail(error); child.stdin.end(); }
  });
  child.on("error", fail); child.on("exit", (code, signal) => fail(new Error(`target bridge exited ${code ?? signal}`)));
  child.stdin.on("error", fail);
  const request = (op, args = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("target bridge is closed"));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`target ${op} timeout`)); child.stdin.end(); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
  });
  return { request, end: () => child.stdin.end() };
}
export async function openDriver(opts, { spawnProcess = spawn } = {}) {
  opts = targetOptions(opts);
  if (!opts.driverRoot?.startsWith("/") || !/^[a-f0-9]{40}$/.test(opts.sha) || !/^[a-f0-9]{40}$/.test(opts.driverSha)) throw new Error("absolute reviewed driver-root and exact SHA required");
  const spec = targetCommand(opts, NODE, [`${opts.driverRoot}/scripts/xmac/bridge.mjs`]);
  const child = spawnProcess(spec.command, spec.args, { stdio: ["pipe", "pipe", "inherit"] });
  const transport = connectProcess(child);
  try {
    const target = await transport.request("start", opts);
    return { target, call: (name, args) => transport.request("call", { name, args }),
      spawnLeadSeat: args => transport.request("spawnLeadSeat", args),
      readScreen: surface => transport.request("readScreen", { surface }),
      focusedSurface: () => transport.request("focusedSurface"),
      processArgs: agentId => transport.request("processArgs", { agentId }),
      verifyClosed: agentId => transport.request("verifyClosed", { agentId }),
      sweepChildren: () => transport.request("sweepChildren"),
      close: async () => { try { return await transport.request("finish"); } finally { transport.end(); } } };
  } catch (error) { transport.end(); throw error; }
}

// Transfers tracked CODE only, never a HOME/auth/config directory. No installed keg write.
export function prepareBuild(opts, sha, cwd) {
  targetOptions(opts);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("exact build SHA required");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const archive = execFileSync("git", ["archive", "--format=tar", sha], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  const execTarget = (command, args, input) => {
    const spec = targetCommand(opts, command, args);
    return execFileSync(spec.command, spec.args, { input, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }).trim();
  };
  const root = execTarget(NODE, ["-e", "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),process.argv[1])))", `cmux-xmac-replay-${randomUUID()}-`]);
  if (!/^\/[^\r\n]+\/cmux-xmac-replay-[A-Za-z0-9-]+$/.test(root)) throw new Error("unsafe target build prefix");
  execTarget("/usr/bin/tar", ["-x", "-C", root], archive);
  execTarget("/usr/bin/env", [`BUN_INSTALL_CACHE_DIR=${root}/.cache/bun`, "/opt/homebrew/bin/bun", "install", "--frozen-lockfile", "--ignore-scripts", "--cwd", root]);
  execTarget("/opt/homebrew/bin/bun", ["run", "--cwd", root, "build"]);
  execTarget(NODE, ["-e", "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({sha:process.argv[2]}),{mode:0o600,flag:'wx'})", `${root}/xmac-build.json`, sha]);
  return { root, sha };
}
