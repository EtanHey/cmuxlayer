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
  const ids = new Set();
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
function snapshot(plan, row, expected) {
  identity(row?.identity);
  if (!same(row.identity, plan.identity) || !same(row.binding, expected) || row.observerEpoch !== plan.observerEpoch ||
      !row.resources || typeof row.resources !== "object" || Array.isArray(row.resources) || Object.keys(row.resources).length > 4096) throw Error("snapshot source/account/observer identity changed");
}
export function verifyHappycamprEffects(plan, before, after, expected) {
  validateHappycamprPlan(plan, expected); snapshot(plan, before, expected); snapshot(plan, after, expected);
  for (const effect of plan.effects) if (!same(before.resources[effect.id] ?? null, effect.before) || !same(after.resources[effect.id], effect.owned)) throw Error("before/after effect witness mismatch");
  for (const id of new Set([...Object.keys(before.resources), ...Object.keys(after.resources)])) {
    if (same(before.resources[id], after.resources[id])) continue;
    const effect = plan.effects.find(row => row.id === id);
    if (!effect || !same(after.resources[id], effect.owned)) throw Error("unresolved/foreign effect: " + id);
  }
  return { status: "PASS", contract: plan.contract, run: plan.run, config: expected.config };
}
export function planHappycamprCleanup(plan, before, current, expected) {
  validateHappycamprPlan(plan, expected); snapshot(plan, before, expected); snapshot(plan, current, expected);
  const actions = [], pending = [];
  for (const effect of plan.effects) {
    if (!same(before.resources[effect.id] ?? null, effect.before) || !same(current.resources[effect.id], effect.owned)) { pending.push(effect.id); continue; }
    actions.push({ id: effect.id, kind: effect.kind, identity: effect.owned, restore: effect.before,
      operation: effect.before != null ? "restore-if-unchanged" : effect.kind === "directory" ? "rmdir-if-empty" :
        effect.kind === "process" ? "stop-exact-pid-start" : ["workspace", "surface"].includes(effect.kind) ? "close-exact-uuid-epoch" : "unlink-exact-identity" });
  }
  for (const id of new Set([...Object.keys(before.resources), ...Object.keys(current.resources)])) if (!plan.effects.some(row => row.id === id) &&
      (id.startsWith(plan.scratch.path + "/") || !same(before.resources[id], current.resources[id]))) pending.push(id);
  return { status: pending.length ? "PENDING" : "READY", actions, preserved: pending, executes: false };
}
