// Read existing private endpoints only. Constructing/importing never connects.
import * as filesystem from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { rpc } from "../soak-runtime.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? "");
export const hostQuery = (command, args) => {
  if (!["/bin/ps", "/usr/sbin/lsof", "/usr/bin/git", "/usr/bin/defaults", "/bin/launchctl"].includes(command)) throw Error("host query unsupported");
  try { return execFileSync(command, args, { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim(); }
  catch (error) { if (command === "/bin/ps" && error.status === 1 && error.stdout === "" && error.stderr === "") return ""; throw error; }
};
async function servingHealth(peer, signal) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const root = peer.process.entry.slice(0, -"/dist/daemon.js".length);
  const { SocketJsonRpcTransport } = await import(pathToFileURL(root + "/dist/daemon.js"));
  if (signal.aborted) throw Error("serving transport aborted before connection");
  const socket = net.createConnection(peer.socket.path); socket.pause();
  const client = new Client({ name: "owned501-observer", version: "1" });
  const abort = () => socket.destroy(); signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  socket.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) socket.destroy(Error("health response limit")); });
  try {
    await client.connect(new SocketJsonRpcTransport(socket), { signal, timeout: 3000 });
    const response = await client.callTool({ name: "control_health", arguments: { detail: "terse" } }, undefined, { signal, timeout: 3000 });
    if (response.isError) throw Error("serving health unavailable");
    const health = response.structuredContent?.health;
    return { version: client.getServerVersion()?.version, nativeSocket: health?.transport?.current_socket_path };
  } finally { signal.removeEventListener("abort", abort); socket.destroy(); await client.close(); }
}
export function createHostTopology(plan, io = {}) {
  const fs = io.fs ?? filesystem, read = io.query ?? hostQuery;
  const control = plan.composition?.topologyPeer?.socket?.path, native = plan.composition?.topologyPeer?.nativeSocket?.path;
  if (plan.composition?.transport !== "private-daemon-v1" || [control, native].some(path => typeof path !== "string" || !path.startsWith(plan.scratch.path + "/"))) throw Error("explicit private serving/native endpoints required");
  const file = path => {
    const before = fs.lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 501 || before.mode & 0o022 || before.nlink !== 1 || before.size > 16 * 1024 * 1024 || fs.realpathSync(path) !== path) throw Error("serving product file identity invalid");
    const bytes = fs.readFileSync(path), after = fs.lstatSync(path);
    if (["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) throw Error("serving product bytes changed");
    return bytes;
  };
  const socketOwner = path => {
    const stat = fs.lstatSync(path, { bigint: true });
    if (!stat.isSocket() || stat.isSymbolicLink() || Number(stat.uid) !== 501 || (Number(stat.mode) & 0o777) !== 0o600 || [Number(stat.dev), Number(stat.ino)].some(n => !Number.isSafeInteger(n) || n < 1) || stat.birthtimeNs === undefined || stat.ctimeNs === undefined || fs.realpathSync(path) !== path) throw Error("serving socket canonical/owner/mode invalid");
    const owners = [], lines = read("/usr/sbin/lsof", ["-n", "-U", "-a", "-Fpun", "--", path]).split("\n"); let owner;
    for (const line of lines) {
      if (line.startsWith("p")) owner = { pid: Number(line.slice(1)) };
      if (line.startsWith("u") && owner) owner.uid = Number(line.slice(1));
      if (line === "n" + path && owner) owners.push(owner);
    }
    if (owners.length !== 1 || !Number.isSafeInteger(owners[0].pid) || owners[0].pid <= 1 || owners[0].uid !== 501) throw Error("serving socket PID unavailable/ambiguous");
    const pid = owners[0].pid, raw = read("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,comm="]);
    const match = /^\s*(\d+)\s+(.+?)\s+(\/[^\r\n]+)\s*$/.exec(raw);
    if (!match || Number(match[1]) !== 501) throw Error("serving PID/start/UID unavailable");
    return { socket: { path, uid: Number(stat.uid), mode: Number(stat.mode) & 0o777, dev: Number(stat.dev), ino: Number(stat.ino) },
      process: { pid, uid: 501, start: match[2], executable: match[3] }, birthtimeNs: String(stat.birthtimeNs), ctimeNs: String(stat.ctimeNs) };
  };
  const peer = () => {
    const owner = socketOwner(control), app = socketOwner(native);
    const args = read("/bin/ps", ["-p", String(owner.process.pid), "-o", "args="]), argv = /^(\/\S+) (\/\S+\/dist\/daemon.js)$/.exec(args);
    if (!argv || argv[1] !== owner.process.executable || fs.realpathSync(argv[2]) !== argv[2]) throw Error("serving exact Node/entry unavailable");
    const root = argv[2].slice(0, -"/dist/daemon.js".length);
    const node = io.runtimeIdentity ? io.runtimeIdentity() : { node: fs.realpathSync(argv[1]), sha256: hash(file(argv[1])) };
    if (root !== plan.scratch.path + "/candidate" || node.node !== argv[1] || node.sha256 !== plan.runtime.sha256) throw Error("serving private root/Node mismatch");
    const manifestBytes = file(root + "/dist-manifest.json"), buildBytes = file(root + "/build-identity.json"), packageBytes = file(root + "/package.json");
    const manifest = JSON.parse(manifestBytes), build = JSON.parse(buildBytes);
    if (Object.keys(manifest).length !== 390 || build.dist_manifest_sha256 !== hash(manifestBytes) || build.inputs?.["package.json"] !== hash(packageBytes)) throw Error("serving build manifest invalid");
    for (const [path, digest] of Object.entries(manifest)) {
      if (!/^dist\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..") || hash(file(root + "/" + path)) !== digest) throw Error("serving dist bytes mismatch");
    }
    const head = read("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"]), tree = read("/usr/bin/git", ["-C", root, "rev-parse", "HEAD^{tree}"]);
    if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(tree) || build.build_head !== head) throw Error("serving Git/build provenance unavailable");
    return { epoch: `cmux:${native}#socket=${app.socket.dev}:${app.socket.ino}:${app.birthtimeNs}:${app.ctimeNs}@static`,
      product: { head, tree, version: JSON.parse(packageBytes).version, manifest: hash(manifestBytes), buildIdentity: hash(buildBytes) },
      socket: owner.socket, process: { ...owner.process, entry: argv[2] },
      nativeSocket: { ...app.socket, pid: app.process.pid, start: app.process.start, executable: app.process.executable, birthtimeNs: app.birthtimeNs, ctimeNs: app.ctimeNs } };
  };
  const bounded = async (work, parent) => {
    const controller = new AbortController(), deadline = Date.now() + 5000; let timer, abort;
    const cancellation = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(Error("501 transport aborted")); };
      parent?.addEventListener("abort", abort, { once: true }); if (parent?.aborted) abort();
    });
    try { return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw Error("501 transport aborted"); return work(controller.signal); }).then(value => { if (controller.signal.aborted || Date.now() > deadline) throw Error("501 transport deadline"); return value; }), cancellation,
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("501 transport deadline")); }, 5000); })]); }
    finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); controller.abort(); }
  };
  const observePeer = parent => bounded(async signal => {
    const before = peer(), health = await (io.health ?? servingHealth)(before, signal);
    if (signal.aborted) throw Error("serving observation aborted");
    if (health.version !== before.product.version || health.nativeSocket !== native || !same(before, peer())) throw Error("serving candidate/peer changed");
    return before;
  }, parent);
  const readTopology = () => bounded(async signal => {
    const before = await observePeer(signal);
    const call = async (method, params = {}) => {
      if (signal.aborted) throw Error("501 transport aborted");
      const value = await (io.rpc ?? rpc)(native, method, params, { signal, timeoutMs: 3000, maxBytes: 1024 * 1024 });
      if (signal.aborted || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw Error("501 topology response unavailable/oversized");
      return value;
    };
    const list = (value, key) => { if (!Array.isArray(value?.[key]) || value[key].length > 1024) throw Error("complete topology inventory unavailable"); return value[key]; };
    const workspaces = [], surfaces = [], aliases = new Map();
    const identify = row => { if (!uuid(row?.id)) throw Error("topology UUID unavailable"); if (row.ref) { if (aliases.has(row.ref)) throw Error("topology ref ambiguous"); aliases.set(row.ref, row.id); } return row.id; };
    for (const window of list(await call("window.list"), "windows")) {
      const windowId = identify(window);
      for (const workspace of list(await call("workspace.list", { window_id: windowId }), "workspaces")) {
        const workspaceId = identify(workspace); workspaces.push({ uuid: workspaceId });
        const response = await call("surface.list", { workspace_id: workspaceId });
        for (const surface of list(response, "surfaces")) {
          const ref = surface.workspace_id ?? surface.workspace_ref ?? response.workspace_id ?? response.workspace_ref;
          const parent = uuid(ref) ? ref : aliases.get(ref);
          if (parent !== workspaceId) throw Error("surface transport relationship missing/mismatch");
          surfaces.push({ uuid: identify(surface), workspace: parent });
        }
        if (workspaces.length > 1024 || surfaces.length > 1024) throw Error("topology total inventory limit");
      }
    }
    const raw = await call("system.identify"), focused = raw?.focused;
    if (!focused || !Object.hasOwn(focused, "workspace_ref") || !Object.hasOwn(focused, "surface_ref")) throw Error("focus observation unavailable");
    const resolve = ref => ref === null ? null : uuid(ref) ? ref : aliases.get(ref) ?? (() => { throw Error("focus ref unresolved"); })();
    const result = { complete: true, epoch: before.epoch, workspaces, surfaces, focus: { workspace: resolve(focused.workspace_ref), surface: resolve(focused.surface_ref) } };
    if (!same(before, await observePeer(signal))) throw Error("501 serving peer changed during inventory");
    return result;
  });
  return { observePeer, readTopology };
}
