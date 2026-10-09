// Connected 501 admission and scoped snapshots; cleanup never executes.
import { constants } from "node:fs";
import * as filesystem from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createProtectedCollector, protectedIdentity, validateScopeReceipt } from "./account-observer.mjs";
import { validateObserverRequest, checkpointSummary, observerSourceFiles } from "./account-observer-bridge.mjs";
import { validateHappycamprPlan, verifyHappycamprEffects, planHappycamprCleanup, happycamprContract, protectedEndpoint, retainedDiagnostics } from "./happycampr-effects.mjs";
import { admitAppStart } from "./app-admission.mjs";
const canonical = value => JSON.stringify(value, (_key, row) => row && typeof row === "object" && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? "");
export const runtimeSourceFiles = ["scripts/xmac/m1-ratchet.mjs", "scripts/xmac/fixture-launchers.mjs", "scripts/xmac/fixture-attestation.mjs",
  "scripts/ratchet-fixture-tui.mjs", "scripts/soak-runtime.mjs", "scripts/soak-app-guard.mjs", "scripts/cmux-session-guard.mjs",
  "scripts/xmac/production-guard.mjs", "scripts/xmac/account-home.mjs", "scripts/xmac/dedicated-account.mjs", "scripts/xmac/account-observer.mjs", "scripts/xmac/account-observer-bridge.mjs", "scripts/xmac/driver.mjs", "scripts/xmac/fixture-shell.mjs", "scripts/xmac/app-admission.mjs", "scripts/xmac/startup-probe.mjs", "scripts/xmac/close-preferences.mjs", "scripts/xmac/close-preferences.swift", "scripts/xmac/target.mjs", "scripts/xmac/argv-preflight.mjs", "scripts/xmac/scenario-repo.mjs", "scripts/xmac/launch-cwd.mjs", "bun.lock", "package.json", "scripts/xmac/happycampr-effects.mjs", "scripts/xmac/happycampr-runtime.mjs"];
const query = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim(); }
  catch (error) { if (cmd === "/bin/ps" && error.status === 1 && error.stdout === "" && error.stderr === "") return ""; throw error; }
};
export function createHappycamprSnapshotAdapter(plan, expected, io = {}) {
  const fs = io.fs ?? filesystem, run = io.query ?? query, retained = retainedDiagnostics(plan);
  if (retained && ["openSync", "closeSync", "fstatSync", "readSync"].some(name => typeof fs[name] !== "function")) throw Error("bounded descriptor diagnostic sampling required");
  const identity = io.identity ?? (() => ({ ...protectedIdentity(), consoleUid: fs.lstatSync("/dev/console").uid, aqua: !!run("/bin/launchctl", ["print", "gui/501"]) }));
  const absent = read => { try { return read(); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  const readPath = (path, kind, hashFile = true) => {
    const stat = absent(() => fs.lstatSync(path)); if (!stat) return null;
    if (retained?.directories.includes(path) && (stat.uid !== 501 || stat.mode & 0o7000 || (stat.mode & 0o777) !== 0o700)) throw Error("unsafe retained parent permissions");
    if (fs.realpathSync(path) !== path || stat.isSymbolicLink()) throw Error("scoped path link/canonical mismatch");
    const actualKind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSocket() ? "socket" : null;
    if (!actualKind || kind && (kind === "marker" ? actualKind !== "file" : actualKind !== kind)) throw Error("scoped path kind mismatch");
    const row = { kind: kind ?? actualKind, canonical: path, uid: stat.uid, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
    if (actualKind === "file") {
      if (stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw Error("scoped file size/links invalid");
      row.nlink = stat.nlink;
      if (hashFile) row.hash = hash(fs.readFileSync(path));
    }
    const after = fs.lstatSync(path);
    if (["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].some(key => stat[key] !== after[key])) throw Error("scoped file changed during read");
    return row;
  };
  const diagnosticMetadata = (path, stat) => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 501 || stat.mode & 0o7077 || stat.nlink !== 1 ||
        !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.ino <= 0 ||
        !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > 16 * 1024 * 1024) throw Error("unsafe retained diagnostic structure");
    return { kind: "file", canonical: path, uid: stat.uid, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino,
      nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  };
  const diagnosticPath = path => {
    const stat = absent(() => fs.lstatSync(path)); if (!stat) return null;
    const metadata = diagnosticMetadata(path, stat), canonical = absent(() => fs.realpathSync(path));
    if (canonical === null) return null;
    if (canonical !== path) throw Error("retained diagnostic canonical escape");
    return metadata;
  };
  const sampleDiagnostic = path => {
    const observed = diagnosticPath(path), row = { path, status: observed ? "present" : "absent", attribution: "unproven",
      observed, descriptor: null, descriptorAfter: null, pathAfter: observed, sample: "" };
    if (!observed) return row;
    // One bounded positional read. Safe concurrent content/path changes are evidence, never ownership.
    const fd = absent(() => fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    if (fd !== null) try {
      row.descriptor = diagnosticMetadata(path, fs.fstatSync(fd));
      const bytes = Buffer.alloc(4096), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length) throw Error("diagnostic read bound invalid");
      row.sample = bytes.subarray(0, count).toString("base64");
      row.descriptorAfter = diagnosticMetadata(path, fs.fstatSync(fd));
    } finally { fs.closeSync(fd); }
    row.pathAfter = diagnosticPath(path);
    if (!same(observed, row.descriptor) || !same(row.descriptor, row.descriptorAfter) || !same(row.descriptorAfter, row.pathAfter)) row.status = "unstable";
    return row;
  };
  const captureTopology = (id, topology) => {
    if (!topology || topology.epoch !== plan.observerEpoch) throw Error("scoped RPC observer unavailable/foreign");
    const resources = {}, processes = new Map(), effects = [...plan.effects, ...(io.lifecycle?.targets() ?? [])];
    for (const effect of effects.filter(row => row.kind === "process")) {
      const raw = run("/bin/ps", ["-p", String(effect.owned.pid), "-o", "uid=,lstart=,comm="]);
      if (!raw) continue;
      const match = /^\s*(\d+)\s+(.+?)\s+(\/\S+)\s*$/.exec(raw); if (!match) throw Error("owned process witness unavailable");
      const args = run("/bin/ps", ["-p", String(effect.owned.pid), "-o", "args="]);
      if (args !== (effect.owned.argv ?? plan.runtime.node + " " + effect.owned.entry)) throw Error("owned process entry/argv mismatch");
      const row = { kind: "process", uid: Number(match[1]), pid: effect.owned.pid, start: match[2], executable: match[3], entry: effect.owned.entry, distManifest: plan.binding.product.manifest };
      if (effect.owned.argv) row.argv = args;
      resources[effect.id] = row; processes.set(row.pid, row);
    }
    let count = 0;
    const walk = path => {
      if (++count > 1024) throw Error("scoped scratch inventory limit");
      if (retained?.paths.includes(path)) return;
      const declared = [...effects, ...(io.lifecycle?.paths ?? []).map(row => ({ id: row.path, kind: row.kind }))].find(row => row.id === path), row = readPath(path, declared?.kind, !!declared);
      if (!row) return; resources[path] = row;
      if (row.kind === "directory") for (const name of fs.readdirSync(path)) {
        if (name.includes("/") || name === "." || name === "..") throw Error("scoped directory entry invalid"); walk(path + "/" + name);
      }
    };
    walk(plan.scratch.path);
    // Scratch root is an admission witness, not an implicit cleanup effect.
    const scratch = resources[plan.scratch.path]; delete resources[plan.scratch.path];
    if (!scratch || !same({ ...plan.scratch, kind: "directory" }, { ...scratch, path: scratch.canonical })) throw Error("scratch identity changed");
    let diagnostics;
    if (retained) {
      const directories = retained.directories.map(path => ({ path, identity: path === plan.scratch.path ? scratch : resources[path] ?? null }));
      for (const row of directories) {
        row.status = row.identity ? "present" : "absent";
        if (row.identity && (row.identity.kind !== "directory" || row.identity.uid !== 501 || row.identity.mode !== 0o700)) throw Error("unsafe retained parent");
      }
      diagnostics = { contract: retained.contract, directories, observations: retained.paths.map(sampleDiagnostic) };
      for (const row of directories) if (!same(row.identity, readPath(row.path, "directory"))) throw Error("retained parent identity changed during sampling");
    }
    for (const effect of effects) {
      if (effect.kind === "marker") { const row = readPath(effect.id, "marker"); if (row) resources[effect.id] = row; }
      if (effect.kind === "socket" && resources[effect.id]) {
        const owner = processes.get(effect.owned.pid); if (!owner) throw Error("owned socket process missing");
        const files = run("/usr/sbin/lsof", ["-n", "-U", "-a", "-p", String(owner.pid), "-Fpn"]).split("\n");
        if (!files.includes(`p${owner.pid}`) || !files.includes(`n${effect.id}`)) throw Error("owned socket owner mismatch");
        Object.assign(resources[effect.id], { pid: owner.pid, start: owner.start });
        if (io.lifecycle) {
          const stat = fs.lstatSync(effect.id, { bigint: true });
          if (stat.birthtimeNs === undefined || stat.ctimeNs === undefined || Number(stat.dev) !== resources[effect.id].dev || Number(stat.ino) !== resources[effect.id].ino) throw Error("created socket epoch unavailable/changed");
          Object.assign(resources[effect.id], { birthtimeNs: String(stat.birthtimeNs), ctimeNs: String(stat.ctimeNs),
            ownedEpoch: `owned501:${effect.id}#${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}@pid=${owner.pid}:${owner.start}` });
        }
      }
    }
    for (const kind of ["workspace", "surface"]) {
      const rows = topology[kind + "s"];
      if (!Array.isArray(rows) || rows.length > 1024) throw Error("scoped UUID inventory unavailable");
      for (const row of rows) {
        if (!uuid(row.uuid) || kind === "surface" && !uuid(row.workspace) || resources[kind + ":" + row.uuid]) throw Error("scoped UUID missing/ambiguous");
        resources[kind + ":" + row.uuid] = { kind, uuid: row.uuid, observerEpoch: topology.epoch, ...(kind === "surface" ? { workspace: row.workspace } : {}) };
      }
    }
    for (const effect of [...plan.effects.filter(row => row.kind === "setting"), ...(plan.protectedSettings ?? [])]) {
      const row = effect.owned;
      if (row?.domain !== "com.cmuxterm.app" || !/^[A-Za-z0-9_.-]{1,64}$/.test(row.key) || effect.id !== `setting:${row.domain}:${row.key}`) throw Error("scoped settings key invalid");
      resources[effect.id] = { kind: "setting", domain: row.domain, key: row.key, value: run("/usr/bin/defaults", ["read", row.domain, row.key]) };
    }
    // Validate the complete topology before accepting any baseline or later observation.
    const workspaces = new Set(topology.workspaces.map(row => row.uuid.toLowerCase()));
    const surfaces = new Map(topology.surfaces.map(row => [row.uuid.toLowerCase(), row.workspace.toLowerCase()]));
    if (workspaces.size !== topology.workspaces.length || surfaces.size !== topology.surfaces.length ||
        [...surfaces.values()].some(workspace => !workspaces.has(workspace))) throw Error("scoped topology relationship missing/ambiguous");
    const focus = topology.focus;
    if (!focus || focus.workspace !== null && !uuid(focus.workspace) || focus.surface !== null && !uuid(focus.surface)) throw Error("focus witness missing");
    const workspace = focus.workspace === null ? null : focus.workspace.toLowerCase();
    const surface = focus.surface === null ? null : focus.surface.toLowerCase();
    if (workspace !== null && !workspaces.has(workspace) ||
        surface !== null && (workspace === null || !surfaces.has(surface) || surfaces.get(surface) !== workspace)) throw Error("focus relationship unresolved");
    resources["protected-focus"] = { workspace: focus.workspace, surface: focus.surface };
    const finish = after => {
      if (!same(id, identity()) || !same(topology, after)) throw Error("501 identity/topology changed during snapshot");
      return { identity: id, binding: structuredClone(expected), observerEpoch: topology.epoch, resources, ...(diagnostics ? { diagnostics } : {}) };
    };
    const after = io.topology(); return after?.then ? after.then(finish) : finish(after);
  };
  const capture = () => {
    const id = identity(), topology = io.topology?.();
    return topology?.then ? topology.then(value => captureTopology(id, value)) : captureTopology(id, topology);
  };
  const attest = () => {
    validateHappycamprPlan(plan, expected);
    if (plan.executionApproved !== true || plan.nativeApproved !== true || plan.zeroModel !== true || !same(identity(), plan.identity)) throw Error("501 actual admission witness/approval missing");
    const source = plan.sourceManifest, candidate = plan.scratch.path + "/candidate";
    if (source?.root !== plan.scratch.path + "/fixture" || source.head !== expected.source || !/^[a-f0-9]{40}$/.test(source.tree) ||
        runtimeSourceFiles.some(path => !/^[a-f0-9]{64}$/.test(source.files?.[path])) ||
        (io.modulePath ?? fileURLToPath(import.meta.url)) !== source.root + "/scripts/xmac/happycampr-runtime.mjs") throw Error("501 executing source manifest mismatch");
    if (hash(canonical(Object.fromEntries(observerSourceFiles.map(path => [path, source.files[path]])))) !== expected.observer ||
        (plan.protectedSettings ?? []).length > 64) throw Error("501 observer manifest mismatch");
    for (const [path, digest] of Object.entries(source.files)) {
      const ownedCapture = plan.composition?.ownedStages && ["tests/fixtures/composer-overlays/codex-boot.txt", "tests/fixtures/codex-0.157/idle-empty.txt", "tests/fixtures/codex-0.157/idle-submitted-working.txt"].includes(path);
      if ((!/^(scripts\/[A-Za-z0-9_./-]+|package.json|bun.lock)$/.test(path) && !ownedCapture) || path.split("/").includes("..") || readPath(source.root + "/" + path, "file")?.hash !== digest) throw Error("501 source bytes mismatch");
    }
    const node = (io.runtimeIdentity ?? (() => ({ node: fs.realpathSync(process.execPath), sha256: hash(fs.readFileSync(plan.runtime.node)) })))();
    if (!same(node, plan.runtime)) throw Error("501 running Node mismatch");
    for (const name of ["dist-manifest.json", "build-identity.json", "package.json"]) if (!readPath(candidate + "/" + name, "file")) throw Error("501 candidate metadata missing");
    const manifestBytes = fs.readFileSync(candidate + "/dist-manifest.json"), buildBytes = fs.readFileSync(candidate + "/build-identity.json");
    if (hash(manifestBytes) !== expected.product.manifest || hash(buildBytes) !== expected.product.buildIdentity) throw Error("501 candidate manifest mismatch");
    const manifest = JSON.parse(manifestBytes), build = JSON.parse(buildBytes);
    const packageBytes = fs.readFileSync(candidate + "/package.json");
    if (build.build_head !== expected.product.head || build.dist_manifest_sha256 !== expected.product.manifest || Object.keys(manifest).length !== 390 || JSON.parse(packageBytes).version !== expected.product.version || hash(packageBytes) !== build.inputs?.["package.json"]) throw Error("501 candidate identity mismatch");
    for (const [path, digest] of Object.entries(manifest)) if (!/^dist\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..") || readPath(candidate + "/" + path, "file")?.hash !== digest) throw Error("501 candidate dist mismatch");
  };
  return { identity, capture, attest };
}
export async function startHappycamprRuntime(opts) {
  const plan = structuredClone(opts.happycamprPlan), expected = structuredClone(opts.expectedBinding), observations = [];
  const result = { status: "FAIL", observer_checkpoints: observations, cleanup: { status: "PENDING", actions: [], executes: false }, native: "NOT_PROVEN" };
  const lifecycle = opts.happycamprIO?.lifecycle;
  let before, last, primary, observe, fresh = false;
  const retained = retainedDiagnostics(plan);
  if (retained) result.diagnostic_evidence = { contract: retained.contract, attribution: "unproven", checkpoints: [] };
  try {
    if (opts.target !== "m1-gate" || opts.fixtureMode !== true || opts.accountContract !== happycamprContract || opts.humanSessionQuitApproved) throw Error("explicit501 runtime routing required");
    const adapter = createHappycamprSnapshotAdapter(plan, expected, opts.happycamprIO), collect = createProtectedCollector({ identity: adapter.identity, captureEffects: adapter.capture });
    let sequence = 0, channelFailed = false;
    observe = async phase => {
      fresh = false;
      if (channelFailed) throw Error("501 observer channel already failed");
      let row;
      try {
        adapter.attest();
        const request = { run: plan.run, nonce: randomUUID().replaceAll("-", ""), sequence: ++sequence, phase, identifiers: ["runtime501"], agentIds: [...(plan.agentIds ?? [])] };
        validateObserverRequest(request, plan.run, sequence);
        const emitted = collect(request); row = validateScopeReceipt(emitted?.then ? await emitted : emitted, request);
      } catch (error) { channelFailed = true; throw error; }
      last = row.snapshot; fresh = true;
      observations.push(checkpointSummary(row));
      if (retained) {
        const checkpoints = result.diagnostic_evidence.checkpoints, previous = checkpoints.at(-1)?.evidence;
        const transitions = last.diagnostics.observations.map((current, index) => {
          const prior = previous?.observations[index], old = prior?.pathAfter, next = current.pathAfter;
          const transition = current.status === "unstable" ? "unstable" : !prior ? "initial" : !old && next ? "appeared" : old && !next ? "deleted" :
            old && next && (old.dev !== next.dev || old.ino !== next.ino) ? "replaced" : next?.size > old?.size ? "grew" :
            next?.size < old?.size ? "truncated" : prior.sample !== current.sample ? "sample_changed" : "unchanged";
          return { path: current.path, transition };
        });
        const active = previous?.observations[0]?.pathAfter, rotated = last.diagnostics.observations[1]?.pathAfter;
        checkpoints.push({ phase, sequence, evidence: structuredClone(last.diagnostics), transitions,
          rotation_observed: !!(active && rotated && active.dev === rotated.dev && active.ino === rotated.ino) });
      }
      if (!same(last.identity, plan.identity)) throw Error("501 snapshot account mismatch");
      before ??= structuredClone(last);
      lifecycle?.check(last);
      const created = lifecycle?.effects() ?? [];
      if (Object.keys(before.resources).some(id => id.startsWith(plan.scratch.path + "/") && !plan.effects.some(row => row.id === id) && !protectedEndpoint(plan, id, before.resources[id]))) throw Error("501 unmanifested scratch baseline");
      for (const effect of plan.effects) {
        if (!same(before.resources[effect.id] ?? null, effect.before)) throw Error("501 baseline owned witness mismatch");
        const current = last.resources[effect.id] ?? null;
        if (!same(current, effect.before) && !same(current, effect.owned)) throw Error("501 unresolved owned effect");
      }
      for (const id of new Set([...Object.keys(before.resources), ...Object.keys(last.resources)])) if (!same(before.resources[id], last.resources[id]) && ![...plan.effects, ...created].some(row => row.id === id)) throw Error("501 unresolved foreign effect");
    };
    await observe("baseline");
    await admitAppStart(opts.happycamprStages, observe);
    await observe("runtime-ready"); verifyHappycamprEffects(plan, before, last, expected, lifecycle?.effects()); result.status = "PASS";
  } catch (error) { primary = String(error); result.error = primary; lifecycle?.reject(error); }
  const finish = () => {
    result.before = before; result.after = last; result.binding = expected; result.run = plan?.run; result.stage_lifecycle = lifecycle?.receipt();
    result.cleanup = { status: "PENDING", actions: [], unobserved: (plan?.effects ?? []).map(row => row.id), executes: false, ...(retained ? { retained: { ...retained, before: before?.diagnostics ?? null, current: last?.diagnostics ?? null } } : {}) };
    if (fresh && before && last) try { result.cleanup = planHappycamprCleanup(plan, before, last, expected, lifecycle?.effects());
      if (lifecycle?.pending()) result.cleanup = { status: "PENDING", actions: [], unobserved: lifecycle.paths.map(row => row.path), executes: false, ...(retained ? { retained: result.cleanup.retained } : {}) }; } catch (error) { result.cleanup.error = String(error); }
    if (primary) { result.status = "FAIL"; result.error = primary; }
    return result;
  };
  finish(); let closing;
  return { receipt: result, close: () => closing ??= (async () => {
    try { if (observe) await observe("run-final"); } catch (error) { primary ??= String(error); lifecycle?.reject(error); }
    lifecycle?.close(); return finish();
  })() }; // Fresh proposals only; no host signals, unlink or restore.
}
