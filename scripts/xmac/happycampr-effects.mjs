// Pure preparation contract. No host reads, process execution, writes or cleanup.
import { createHash } from "node:crypto";
import { posix } from "node:path";
export const happycamprContract = "happycampr-owned-effects-v1";
export const nativeRootProducts = ["report", "spawn", "focus"];
const canonical = value => JSON.stringify(value, (_key, row) => row && typeof row === "object" && !Array.isArray(row) ?
  Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const markers = ["/Users/happycampr/.local/state/cmux/last-socket-path", "/Users/happycampr/Library/Application Support/cmux/last-socket-path", "/private/tmp/cmux-last-socket-path"];
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? "");
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
export const happycamprPlanDigest = plan => { const copy = structuredClone(plan); delete copy.binding.config; return digest(copy); };
// Optional, digest-bound source contract. Retention never grants ownership or attribution.
export function retainedDiagnostics(plan) {
  if (plan.retainedDiagnostics === undefined) return null;
  const root = plan.scratch.path, contract = { contract: "happycampr-retained-diagnostics-v1",
    paths: [root + "/state/daemon.log", root + "/state/daemon.log.1"], directories: [root, root + "/state"] };
  if (!same(plan.retainedDiagnostics, contract) || !plan.composition?.ownedStages || plan.composition.transport !== "private-daemon-v1" ||
      plan.composition.ownedStages.paths.some(row => contract.paths.includes(row.path)) ||
      plan.effects.some(row => [...contract.paths, ...contract.directories].includes(row.id))) throw Error("retained diagnostics contract/ownership overlap invalid");
  return contract;
}
function diagnosticReceipt(plan, snapshot) {
  const retained = retainedDiagnostics(plan); if (!retained) return null;
  const evidence = snapshot.diagnostics;
  if (!evidence || evidence.contract !== retained.contract || !Array.isArray(evidence.observations) || evidence.observations.length !== 2 ||
      !Array.isArray(evidence.directories) || evidence.directories.length !== 2 || retained.paths.some(path => Object.hasOwn(snapshot.resources, path))) throw Error("explicit retained diagnostic receipt required");
  evidence.directories.forEach((row, index) => {
    const path = retained.directories[index];
    if (row.path !== path || row.status !== (row.identity ? "present" : "absent") || index === 0 && !row.identity) throw Error("retained directory receipt invalid");
    if (row.identity) {
      resource("directory", path, row.identity, plan);
      if (row.identity.mode !== 0o700 || index === 0 && !same(row.identity, { kind: "directory", canonical: path, uid: 501, mode: 0o700, dev: plan.scratch.dev, ino: plan.scratch.ino }) ||
          index === 1 && !same(row.identity, snapshot.resources[path])) throw Error("retained directory identity changed");
    } else if (snapshot.resources[path]) throw Error("retained state absence mismatch");
  });
  evidence.observations.forEach((row, index) => {
    const path = retained.paths[index];
    if (row.path !== path || !["present", "absent", "unstable"].includes(row.status) || row.attribution !== "unproven" ||
        row.status === "absent" && (row.observed !== null || row.descriptor !== null || row.descriptorAfter !== null || row.pathAfter !== null || row.sample !== "") ||
        row.status === "unstable" && !row.observed ||
        row.status === "present" && (!row.observed || !row.descriptor || !row.descriptorAfter || !row.pathAfter) ||
        typeof row.sample !== "string" || Buffer.from(row.sample, "base64").length > 4096) throw Error("retained diagnostic observation invalid");
    if (row.observed && !evidence.directories[1].identity) throw Error("diagnostic file without private state parent");
    if (row.status === "present" && (!same(row.observed, row.descriptor) || !same(row.descriptor, row.descriptorAfter) || !same(row.descriptorAfter, row.pathAfter))) throw Error("unstable diagnostics cannot be presented as stable");
    for (const metadata of [row.observed, row.descriptor, row.descriptorAfter, row.pathAfter]) if (metadata &&
        (metadata.kind !== "file" || metadata.canonical !== path || metadata.uid !== 501 || !Number.isInteger(metadata.mode) || metadata.mode < 0 || metadata.mode > 0o777 || metadata.mode & 0o077 ||
         metadata.nlink !== 1 || !Number.isSafeInteger(metadata.dev) || !Number.isSafeInteger(metadata.ino) || metadata.ino <= 0 ||
         !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > 16 * 1024 * 1024 || Object.hasOwn(metadata, "hash"))) throw Error("unsafe retained diagnostic metadata");
  });
  return structuredClone(evidence);
}
export function protectedEndpoint(plan, id, row) {
  if (plan.composition?.transport !== "private-daemon-v1") return false;
  return [plan.composition.topologyPeer?.socket, plan.composition.topologyPeer?.nativeSocket].some(socket =>
    socket?.path === id && same(row, { kind: "socket", canonical: id, uid: socket.uid, mode: socket.mode, dev: socket.dev, ino: socket.ino }));
}
function identity(row) {
  if (row?.username !== "happycampr" || row.uid !== 501 || row.processUid !== 501 || row.consoleUid !== 501 || row.home !== "/Users/happycampr" ||
      row.source !== "os.userInfo+dscl" || row.host !== "Locals-MacBook-Pro.local" || row.aqua !== true || !Number.isInteger(row.dev) || !Number.isInteger(row.ino)) throw Error("happycampr501 identity witness invalid");
}
function resource(kind, id, row, plan) {
  if (!row || row.kind !== kind) throw Error("owned effect witness missing");
  if (["file", "directory", "socket", "marker"].includes(kind)) {
    if (row.canonical !== id || posix.normalize(id) !== id || row.uid !== 501 || !Number.isInteger(row.dev) || !Number.isInteger(row.ino) || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777 || row.mode & 0o022 ||
        (kind === "marker" ? !markers.includes(id) : !(id === plan.scratch.path || id.startsWith(plan.scratch.path + "/"))) ||
        ["file", "marker"].includes(kind) && (row.nlink !== 1 || !/^[a-f0-9]{64}$/.test(row.hash))) throw Error("owned path identity invalid");
  } else if (kind === "process") {
    if (row.uid !== 501 || !Number.isSafeInteger(row.pid) || row.pid <= 1 || id !== `pid:${row.pid}` || typeof row.start !== "string" || !row.start ||
        row.executable !== plan.runtime.node || !["index.js", "daemon.js"].some(file => row.entry === plan.scratch.path + "/candidate/dist/" + file) ||
        row.distManifest !== plan.binding.product.manifest) throw Error("owned PID/start/candidate invalid");
  } else if (["workspace", "surface"].includes(kind)) {
    if (!uuid(row.uuid) || id !== kind + ":" + row.uuid || row.observerEpoch !== plan.observerEpoch || kind === "surface" && !uuid(row.workspace)) throw Error("owned UUID/observer identity invalid");
  } else if (kind === "setting") {
    if (row.domain !== "com.cmuxterm.app" || !/^[A-Za-z0-9_.-]{1,64}$/.test(row.key) || id !== `setting:${row.domain}:${row.key}` || !Object.hasOwn(row, "value")) throw Error("exact settings key witness invalid");
  } else throw Error("unknown owned effect kind");
}
export function validateHappycamprPlan(plan, expectedBinding) {
  identity(plan?.identity);
  if (plan.contract !== happycamprContract || !/^[a-f0-9]{32}$/.test(plan.run) || !same(plan.binding, expectedBinding) ||
      !/^[a-f0-9]{40}$/.test(plan.binding.source) || !/^[a-f0-9]{64}$/.test(plan.binding.observer) || plan.binding.config !== happycamprPlanDigest(plan) ||
      !same(plan.products, nativeRootProducts) || plan.binding.product?.head !== "d539fbefc75327375d144d3108ce1b7a0157d225" ||
      plan.binding.product.tree !== "e5cf40901e80897319f9a9daea0c9982fa604294" || plan.binding.product.version !== "0.4.101" ||
      plan.binding.product.manifest !== "b06ffeb7b29ae1933b385e54f6ac08f365080744ceb69b063608d38a0a5b9c4f" ||
      plan.binding.product.buildIdentity !== "71b55eac8766278d5d6390d05d29d7f14d5895df03654d5ccd74bef6e02248b7" ||
      plan.runtime?.node !== "/opt/homebrew/Cellar/node/26.10.0_2/bin/node" || plan.runtime.sha256 !== "832eaf52cafa7ff1364c2ca378451db14fb043d8d23a5cfd18a0a103d66226fc" ||
      typeof plan.observerEpoch !== "string" || !plan.observerEpoch || !Array.isArray(plan.effects) || plan.effects.length > 1024) throw Error("reviewed501 source/config/product binding invalid");
  const scratch = plan.scratch;
  if (!/^\/Users\/happycampr\/Library\/Caches\/cmuxlayer-native-[A-Za-z0-9-]+$/.test(scratch?.path) || scratch.canonical !== scratch.path ||
      scratch.uid !== 501 || scratch.mode !== 0o700 || !Number.isInteger(scratch.dev) || !Number.isInteger(scratch.ino)) throw Error("owned501 cache scratch invalid");
  retainedDiagnostics(plan);
  const ids = new Set();
  if (plan.composition?.transport === "private-daemon-v1") {
    const endpoints = [plan.composition.topologyPeer?.socket, plan.composition.topologyPeer?.nativeSocket];
    if (!endpoints[0] || !endpoints[1] || endpoints[0].path === endpoints[1].path) throw Error("distinct protected observation endpoints required");
    for (const socket of endpoints) resource("socket", socket.path, { ...socket, kind: "socket", canonical: socket.path }, plan);
    if (plan.effects.some(effect => endpoints.some(socket => socket.path === effect.id))) throw Error("observation endpoint cannot become an owned cleanup effect");
  }
  for (const effect of plan.effects) {
    if (typeof effect.id !== "string" || ids.has(effect.id) || !Object.hasOwn(effect, "before")) throw Error("duplicate/missing effect identity"); ids.add(effect.id);
    resource(effect.kind, effect.id, effect.owned, plan);
    if (effect.before != null) {
      if (["process", "workspace", "surface"].includes(effect.kind)) throw Error("cannot adopt existing PID/workspace/surface");
      resource(effect.kind, effect.id, effect.before, plan);
    }
  }
  for (const effect of plan.effects) {
    if (effect.kind === "surface" && !plan.effects.some(row => row.kind === "workspace" && row.owned.uuid === effect.owned.workspace) ||
        effect.kind === "socket" && !plan.effects.some(row => row.kind === "process" && row.owned.pid === effect.owned.pid && row.owned.start === effect.owned.start)) throw Error("owned topology/socket owner unbound");
  }
  return plan;
}
function createdEffects(plan, effects) {
  if (!Array.isArray(effects) || effects.length > 64) throw Error("created effects limit");
  const retained = retainedDiagnostics(plan);
  const ids = new Set(plan.effects.map(row => row.id));
  for (const effect of effects) {
    if (retained && [...retained.paths, plan.scratch.path].includes(effect.id)) throw Error("diagnostics/root cannot become created ownership");
    if (ids.has(effect.id) || effect.before !== null || !plan.composition?.ownedStages) throw Error("created effect duplicate/adoption"); ids.add(effect.id);
    if (effect.kind === "process" && effect.owned.entry === plan.sourceManifest.root + "/scripts/ratchet-fixture-tui.mjs") {
      const row = effect.owned;
      if (row.uid !== 501 || !Number.isSafeInteger(row.pid) || row.pid <= 1 || effect.id !== "pid:" + row.pid || !row.start || row.executable !== plan.runtime.node ||
          row.argv !== [plan.runtime.node, row.entry, plan.composition.fixture.row, plan.scratch.path + "/ratchet-events.json"].join(" ")) throw Error("fixture PID identity invalid");
    } else resource(effect.kind, effect.id, effect.owned, plan);
    if (["file", "directory", "socket"].includes(effect.kind) && !plan.composition.ownedStages.paths.some(row => row.path === effect.id && row.kind === effect.kind)) throw Error("created path outside manifest");
    if (effect.kind === "socket" && (!/^[0-9]+$/.test(effect.owned.birthtimeNs ?? "") || !/^[0-9]+$/.test(effect.owned.ctimeNs ?? "") || effect.owned.ownedEpoch !== `owned501:${effect.id}#${effect.owned.dev}:${effect.owned.ino}:${effect.owned.birthtimeNs}:${effect.owned.ctimeNs}@pid=${effect.owned.pid}:${effect.owned.start}`)) throw Error("created socket epoch invalid");
    if (effect.kind === "socket" && !effects.some(row => row.kind === "process" && row.owned.pid === effect.owned.pid && row.owned.start === effect.owned.start)) throw Error("created socket owner unbound");
    if (effect.kind === "surface" && !effects.some(row => row.kind === "workspace" && row.owned.uuid === effect.owned.workspace)) throw Error("created surface parent unbound");
  }
}
function snapshot(plan, row, expected) {
  identity(row?.identity);
  if (!same(row.identity, plan.identity) || !same(row.binding, expected) || row.observerEpoch !== plan.observerEpoch ||
      !row.resources || typeof row.resources !== "object" || Array.isArray(row.resources) || Object.keys(row.resources).length > 4096) throw Error("snapshot source/account/observer identity changed");
  diagnosticReceipt(plan, row);
}
export function verifyHappycamprEffects(plan, before, after, expected, created = []) {
  validateHappycamprPlan(plan, expected); createdEffects(plan, created); snapshot(plan, before, expected); snapshot(plan, after, expected);
  for (const effect of [...plan.effects, ...created]) if (!same(before.resources[effect.id] ?? null, effect.before) || !same(after.resources[effect.id], effect.owned)) throw Error("before/after effect witness mismatch");
  for (const id of new Set([...Object.keys(before.resources), ...Object.keys(after.resources)])) {
    if (same(before.resources[id], after.resources[id])) continue;
    const effect = [...plan.effects, ...created].find(row => row.id === id);
    if (!effect || !same(after.resources[id], effect.owned)) throw Error("unresolved/foreign effect: " + id);
  }
  return { status: "PASS", contract: plan.contract, run: plan.run, config: expected.config };
}
export function planHappycamprCleanup(plan, before, current, expected, created = []) {
  validateHappycamprPlan(plan, expected); createdEffects(plan, created); snapshot(plan, before, expected); snapshot(plan, current, expected);
  const actions = [], pending = [], retained = retainedDiagnostics(plan);
  for (const effect of [...plan.effects, ...created]) {
    if (!same(before.resources[effect.id] ?? null, effect.before) || !same(current.resources[effect.id], effect.owned)) { pending.push(effect.id); continue; }
    if (retained?.directories.includes(effect.id)) continue;
    actions.push({ id: effect.id, kind: effect.kind, identity: effect.owned, restore: effect.before,
      operation: effect.before != null ? "restore-if-unchanged" : effect.kind === "directory" ? "rmdir-if-empty" :
        effect.kind === "process" ? "stop-exact-pid-start" : ["workspace", "surface"].includes(effect.kind) ? "close-exact-uuid-epoch" : "unlink-exact-identity" });
  }
  for (const id of new Set([...Object.keys(before.resources), ...Object.keys(current.resources)])) if (![...plan.effects, ...created].some(row => row.id === id) &&
      (id.startsWith(plan.scratch.path + "/") || !same(before.resources[id], current.resources[id])) &&
      !(protectedEndpoint(plan, id, before.resources[id]) && protectedEndpoint(plan, id, current.resources[id]))) pending.push(id);
  return { status: pending.length ? "PENDING" : "READY", actions, preserved: pending, executes: false, ...(retained ? { retained: { ...retained, before: diagnosticReceipt(plan, before), current: diagnosticReceipt(plan, current) } } : {}) };
}
