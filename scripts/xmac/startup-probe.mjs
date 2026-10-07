import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { hostname } from "node:os";
import { normalizeProcessIdentity } from "../cmux-session-guard.mjs";
import { rpc } from "../soak-runtime.mjs";
import { shellQuote } from "./target.mjs";

// Read-only proof of the app that owns the probe's transport. Never log argv.
export function observeProbeOwner(runtime, { exec = execFileSync, lstat = lstatSync, host = hostname, uid = process.getuid } = {}) {
  const { pid } = runtime.receipt.app_process;
  const read = args => exec("ps", args, { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } }).trim();
  const saved = normalizeProcessIdentity(read(["-p", String(pid), "-o", "pid=,lstart=,comm="]));
  const executable = read(["-p", String(pid), "-o", "comm="]);
  const args = read(["-ww", "-p", String(pid), "-o", "args="]).split(/\s+/);
  const index = args.indexOf("--soak-launch-token");
  const token = index >= 0 ? args[index + 1] : null;
  const socket = runtime.env.CMUX_SOCKET_PATH, stat = lstat(socket);
  const files = exec("lsof", ["-n", "-U", "-a", "-p", String(pid), "-Fpn"], { encoding: "utf8", timeout: 5000 }).trim().split("\n");
  return { host: host(), saved, executable, token, socket,
    socketIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    socketOwned: stat.isSocket() && stat.uid === uid() && files.includes(`p${pid}`) && files.includes(`n${socket}`) };
}

export async function runCodexResolutionProbe(runtime, wrapper = null,
  { rpc: request = rpc, observe = observeProbeOwner, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const receipt = runtime.receipt, app = receipt.app_process, socket = runtime.env.CMUX_SOCKET_PATH;
  const expected = receipt.fixtures?.row ? receipt.fixtures.binaries.codex : wrapper;
  if (receipt.fixtures?.row && (!expected || wrapper && wrapper !== expected)) throw new Error("run-owned fixture trap required");
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const expectedSocket = receipt.target === "m1-gate" ? "/tmp/cmux-soak-stable.sock" : receipt.target === "nightly" ? "/tmp/cmux-nightly.sock" : null;
  if (!expectedSocket || socket !== expectedSocket || !uuid(receipt.launch_token) || !app?.saved ||
      !Number.isSafeInteger(app.pid) || app.pid <= 1 || app.launch_token !== receipt.launch_token) throw new Error("startup probe owner receipt missing");
  const owner = { host: receipt.host, saved: app.saved, executable: receipt.app_target?.executable,
    token: receipt.launch_token, socket };
  let socketIdentity;
  const assertOwner = () => {
    const current = observe(runtime);
    if (!current.socketOwned || !current.socketIdentity || !owner.executable ||
        Object.entries(owner).some(([key, value]) => !value || current[key] !== value) ||
        socketIdentity && current.socketIdentity !== socketIdentity) throw new Error("startup probe app/socket ownership changed");
    socketIdentity ??= current.socketIdentity;
  };
  assertOwner();
  const marker = `XMAC_CODEX_${receipt.launch_token}:`, idle = `XMAC_IDLE_${receipt.launch_token}`;
  // OSC 133 marks an actual interactive shell prompt after exec/init. No busy cat.
  const prompt = `%{\x1b]133;A\x07%}${idle}%{\x1b]133;B\x07%} `;
  const command = `printf '%s%s\\n' ${shellQuote(marker)} "$(command -v codex)"; export PS1=${shellQuote(prompt)}; exec /bin/zsh -dfi`;
  const created = await request(socket, "workspace.create", { workspace_id: runtime.workspace, cwd: runtime.cwd,
    initial_command: `/bin/zsh -lc ${shellQuote(command)}` });
  const probe = { workspace_id: created.workspace_id, surface_id: created.surface_id }, window = created.window_id;
  if (!uuid(window) || !uuid(probe.workspace_id) || !uuid(probe.surface_id) || probe.workspace_id === receipt.workspace?.workspace_id) throw new Error("startup probe created identity missing or anchor reused");
  receipt.startup_probe = { ...probe, owner: { ...owner, socketIdentity }, close: "pending" };
  let settled = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assertOwner();
    const text = (await request(socket, "surface.read_text", probe)).text ?? "";
    const resolved = text.split("\n").find(line => line.startsWith(marker))?.slice(marker.length).trim();
    if (resolved?.startsWith("/") && text.includes(idle)) {
      const health = await request(socket, "surface.health", { workspace_id: probe.workspace_id });
      if (health.workspace_id === probe.workspace_id && health.surfaces?.length === 1 &&
          health.surfaces[0].id === probe.surface_id && health.surfaces[0].socket_binding === "bound" &&
          health.surfaces[0].render_health === "rendering") {
        receipt.resolved_codex = resolved; receipt.codex_probe_screen = text;
        receipt.startup_probe.settle = { idle, health }; settled = true; break;
      }
    }
    await sleep(100);
  }
  if (!settled) throw new Error("startup probe did not reach bound rendering idle prompt");
  if (expected && receipt.resolved_codex !== expected) throw new Error("run-owned Codex resolution mismatch");
  assertOwner();
  const value = await request(socket, "surface.list", { workspace_id: probe.workspace_id });
  if (value.workspace_id !== probe.workspace_id || !Array.isArray(value.surfaces) || value.surfaces.length !== 1 || value.surfaces[0].id !== probe.surface_id) throw new Error("startup probe surface ownership changed");
  assertOwner();
  // Any confirmation remains a failure; no EOF, force, retry, or preference write.
  await request(socket, "workspace.close", { workspace_id: probe.workspace_id });
  assertOwner();
  const remaining = await request(socket, "workspace.list", { window_id: window });
  if (!Array.isArray(remaining.workspaces) || remaining.workspaces.some(row => row.id === probe.workspace_id)) throw new Error("startup probe close unverified");
  receipt.startup_probe.close = "unforced"; receipt.startup_probe.closed = true;
}
