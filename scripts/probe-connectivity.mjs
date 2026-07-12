#!/usr/bin/env node
// Minimal MCP connectivity probe: spawn the given MCP server, initialize, call list_surfaces.
// Usage: node probe-connectivity.mjs <serverCmd> <serverArg...>
import { spawn } from "node:child_process";
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", se = ""; const pending = new Map(); let id = 1;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (l) { try { const m = JSON.parse(l); if (typeof m.id === "number" && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } } catch {} }
  }
});
child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (se += c));
function req(method, params) {
  const i = id++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + method)), 15000);
    pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
}
try {
  await req("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const r = await req("tools/call", { name: "list_surfaces", arguments: {} });
  const txt = r.structuredContent ? JSON.stringify(r.structuredContent) : (r.content?.[0]?.text || JSON.stringify(r));
  console.log("PROBE_OK: " + txt.slice(0, 500));
} catch (e) {
  console.log("PROBE_FAIL: " + e.message + " | stderr: " + se.slice(-400));
}
child.kill("SIGTERM");
process.exit(0);
