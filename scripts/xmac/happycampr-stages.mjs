// Owned501 lifecycle. Import and construction validate only; cleanup never executes.
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { admissionStages } from "./app-admission.mjs";
import { validateHappycamprPlan } from "./happycampr-effects.mjs";
import { isolatedEnvironment, shellStartup, PINNED_DMG_SHA256, rpc, acquireNightlyLock } from "../soak-runtime.mjs";
import { verifyFixtureShell } from "./fixture-shell.mjs";
import { verifyClosePreferences } from "./close-preferences.mjs";
const stages = [...admissionStages, "refreshAndQuit", "launch"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? "");
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function createOwnedStageAdapters({ cfg, executionPacket, io, fixtureIO, env }) {
  const plan = structuredClone(cfg.happycamprPlan), spec = plan.composition?.ownedStages, root = plan.scratch.path;
  validateHappycamprPlan(plan, cfg.expectedBinding);
  const native = executionPacket.mode === "host", fs = io.fs, providers = io.stageIO;
  if (["tests/fixtures/composer-overlays/codex-boot.txt", "tests/fixtures/codex-0.157/idle-empty.txt", "tests/fixtures/codex-0.157/idle-submitted-working.txt"].some(path => !/^[a-f0-9]{64}$/.test(plan.sourceManifest.files[path]))) throw Error("captured TUI source data binding required");
  const required = { lock: ["owned.lock"], config: ["home", "zdot", "state", "inbox", "fleet.json", "private-mcp.json"],
    fixture: ["bin", "bin/codex", "bin/claude", "fixture-launchers.zsh", "fixture-manifest.json"],
    environment: ["zdot/.zshenv", "zdot/.zlogin"], launch: ["d.sock", "state/daemon.log", "ratchet-events.json"] };
  const paths = Object.entries(required).flatMap(([stage, paths]) => paths.map(path => ({ stage, path: root + "/" + path,
    kind: ["home", "zdot", "state", "inbox", "bin"].includes(path) ? "directory" : path === "d.sock" ? "socket" : "file" })));
  if (spec?.contract !== "owned-stage-acks-v1" || !same(spec.paths, paths) || !uuid(spec.window) ||
      spec.dmg?.path !== root + "/inputs/cmux.dmg" || spec.dmg.sha256 !== PINNED_DMG_SHA256 ||
      plan.composition.topologyPeer.nativeSocket.executable !== plan.composition.fixture.app + "/Contents/MacOS/cmux" ||
      !spec.appFiles?.[plan.composition.fixture.app + "/Contents/MacOS/cmux"] || !Object.keys(spec.appFiles).length || Object.keys(spec.appFiles).length > 1024 ||
      Object.entries(spec.appFiles).some(([path, hash]) => !path.startsWith(plan.composition.fixture.app + "/") || path.includes("/../") || !/^[a-f0-9]{64}$/.test(hash)) ||
      plan.effects.some(effect => paths.some(path => path.path === effect.id) || ["process", "workspace", "surface"].includes(effect.kind)) ||
      !fs || ["openSync", "closeSync", "fstatSync", "ftruncateSync"].some(name => typeof fs[name] !== "function") ||
      !native && (!providers || ["rpc", "exec", "inventory"].some(name => typeof providers[name] !== "function"))) throw Error("reviewed owned stage paths/providers required");
  // Default native writers provide no exclusive file-generation ACK: refuse before connection.
  if (native && typeof providers?.armLaunchFiles !== "function") throw Error("native launch file creation bridge required");
  const endpoints = [plan.composition.topologyPeer.socket.path, plan.composition.topologyPeer.nativeSocket.path];
  if (paths.some(row => endpoints.includes(row.path)) || spec.paths.some(row => plan.effects.some(effect => effect.id === row.path))) throw Error("read-only observation endpoint/owned path overlap");
  const read = io.query, request = providers?.rpc ?? rpc;
  const fileDigest = providers?.digest ?? (path => sha(fs.readFileSync(path)));
  const exec = providers?.exec ?? ((command, args, options = {}) => execFileSync(command, args, { ...options, timeout: 5000, maxBuffer: 1024 * 1024 }));
  const inventory = providers?.inventory ?? (() => {
    const rows = read("/bin/ps", ["-axo", "uid=,pid=,comm="]).split("\n");
    if (rows.length > 4096) throw Error("process inventory limit");
    return rows.flatMap(line => { const row = /^\s*501\s+(\d+)\s+(.+)$/.exec(line); return row && row[2] === plan.runtime.node ? [Number(row[1])] : []; });
  });
  let baseline, current, failed, next = 0, pending = [], owned = [], existingPids = [], closed = false;
  const ledger = [], attempts = new Set();
  const filesystemAcks = new Map(), handles = new Map();
  const record = (path, stat, bytes) => {
    const slot = paths.find(row => row.path === path && row.stage === stages[next]);
    if (!slot) throw Error("filesystem creation outside active manifest stage");
    filesystemAcks.set(path, { kind: slot.kind, canonical: path, uid: stat.uid, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino,
      ...(slot.kind === "file" ? { nlink: stat.nlink, hash: sha(bytes) } : {}) });
  };
  const creationFs = { ...fs,
    openSync(path, flags, mode) { if (flags !== "wx" || fs.existsSync(path)) throw Error("exclusive creation required"); const fd = fs.openSync(path, flags, mode); handles.set(fd, path); return fd; },
    closeSync(fd) { handles.delete(fd); return fs.closeSync(fd); },
    writeFileSync(path, bytes, options = {}) {
      const fd = typeof path === "number" ? path : creationFs.openSync(path, "wx", options.mode);
      try { fs.writeFileSync(fd, bytes); record(handles.get(fd), fs.fstatSync(fd), bytes); }
      finally { if (typeof path !== "number") creationFs.closeSync(fd); }
    },
    mkdirSync(path, options) {
      fs.mkdirSync(path, options); const fd = fs.openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { record(path, fs.fstatSync(fd)); } finally { fs.closeSync(fd); }
    },
  };

  const fail = error => { failed ??= String(error); throw error; };
  const lifecycle = {
    paths, creationFs, targets: () => [...owned, ...pending].filter(row => row.kind === "process" || row.kind === "socket"),
    effects: () => structuredClone(owned),
    reject(error) { failed ??= String(error); },
    check(snapshot) {
      if (failed || closed) throw Error(failed ?? "owned stage lifecycle closed");
      baseline ??= structuredClone(snapshot); current = snapshot;
      for (const path of paths) if (baseline.resources[path.path]) throw Error("owned creation path was present at baseline");
      for (const effect of owned) if (!same(snapshot.resources[effect.id], effect.owned)) throw Error("created identity lost/replaced");
    },
    receipt: () => ({ contract: spec.contract, ledger, error: failed, closed, epoch: plan.observerEpoch }),
    close() { closed = true; },
    pending: () => failed || pending.length || next !== stages.length,
  };
  const bounded = async work => {
    const abort = new AbortController(), end = Date.now() + 15000; let timer;
    const cancel = () => abort.abort(); providers?.signal?.addEventListener("abort", cancel, { once: true });
    if (providers?.signal?.aborted) abort.abort();
    try {
      if (abort.signal.aborted) throw Error("owned stage aborted");
      const result = await Promise.race([work(abort.signal), new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Error("owned stage deadline")); }, 15000); }),
        new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(Error("owned stage aborted")), { once: true }))]);
      if (abort.signal.aborted || Date.now() > end) throw Error("late creation ACK"); return result;
    } finally { clearTimeout(timer); abort.abort(); providers?.signal?.removeEventListener("abort", cancel); }
  };
  const bind = async (ctx, name, processAck, workspaceAck) => {
    const snapshot = await ctx.captureOwned();
    if (failed || closed) throw Error("late creation ACK after failure/close");
    const effects = paths.filter(row => row.stage === name).map(row => ({ id: row.path, kind: row.kind, before: null, owned: snapshot.resources[row.path] }));
    for (const effect of effects) {
      const row = effect.owned;
      if (effect.kind !== "socket" && !same(row, filesystemAcks.get(effect.id))) throw Error("filesystem creation ACK identity/bytes mismatch");
      if (!row || row.kind !== effect.kind || row.uid !== 501 || row.canonical !== effect.id || row.mode & 0o077 || !Number.isSafeInteger(row.dev) || !Number.isSafeInteger(row.ino) || row.ino <= 0 ||
          effect.kind === "file" && (row.nlink !== 1 || !/^[a-f0-9]{64}$/.test(row.hash))) throw Error("created path independent readback unavailable");
    }
    for (const ack of processAck ?? []) {
      const id = "pid:" + ack.pid, row = snapshot.resources[id];
      if (!Number.isSafeInteger(ack.pid) || ack.pid <= 1 || existingPids.includes(ack.pid) || baseline.resources[id] || owned.some(effect => effect.id === id) ||
          !row || row.uid !== 501 || !row.start || row.executable !== plan.runtime.node || row.entry !== ack.entry || row.argv !== ack.argv) throw Error("creation PID ACK missing/foreign/reused");
      effects.push({ id, kind: "process", before: null, owned: row });
    }
    if (workspaceAck) {
      if (!uuid(workspaceAck.workspace_id) || workspaceAck.window_id !== spec.window) throw Error("workspace creation ACK missing/foreign");
      const id = "workspace:" + workspaceAck.workspace_id, row = snapshot.resources[id];
      const surfaces = Object.entries(snapshot.resources).filter(([_id, row]) => row.kind === "surface" && row.workspace === workspaceAck.workspace_id);
      if (baseline.resources[id] || owned.some(effect => effect.id === id) || !row || row.observerEpoch !== plan.observerEpoch || surfaces.length !== 1) throw Error("workspace ACK reused/unobserved/ambiguous");
      for (const [surfaceId, surface] of surfaces) {
        if (baseline.resources[surfaceId] || surface.observerEpoch !== plan.observerEpoch) throw Error("surface creation readback reused/foreign");
        effects.push({ id: surfaceId, kind: "surface", before: null, owned: surface });
      }
      effects.push({ id, kind: "workspace", before: null, owned: row });
    }
    if (effects.some(effect => !effect.owned || owned.some(row => row.id === effect.id))) throw Error("duplicate creation ACK");
    if (failed || closed) throw Error("late creation ACK after failure/close");
    owned.push(...structuredClone(effects)); pending = [];
    ledger.push({ stage: name, status: "BOUND", effects: effects.map(effect => ({ id: effect.id, kind: effect.kind, identity: effect.owned })) });
  };
  const create = (path, bytes, directory = false) => {
    if (fs.existsSync(path)) throw Error("precreation path no longer absent");
    if (directory) creationFs.mkdirSync(path, { mode: 0o700 }); else creationFs.writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  };
  const mutate = {
    lock: () => acquireNightlyLock(root + "/owned.lock", plan.run, creationFs),
    session: () => { existingPids = inventory(); if (!Array.isArray(existingPids) || existingPids.length > 4096 || existingPids.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw Error("complete process inventory required"); },
    app: () => { for (const [path, hash] of Object.entries(spec.appFiles)) {
      const st = fs.lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.uid !== 501 || st.mode & 0o022 || fs.realpathSync(path) !== path || fileDigest(path) !== hash) throw Error("private app input changed");
    } },
    dmg: () => { if (fileDigest(spec.dmg.path) !== spec.dmg.sha256) throw Error("pinned DMG changed"); },
    config: () => {
      for (const path of ["home", "zdot", "state", "inbox"]) create(root + "/" + path, null, true);
      create(root + "/fleet.json", JSON.stringify({ coordinationDir: root, outbox: false, seatRegistryPath: root + "/state/seats.yaml" }));
      create(root + "/private-mcp.json", JSON.stringify({ mcpServers: {} }));
    },
    fixture: ctx => ctx.installFixture(),
    environment: ctx => {
      const routes = ctx.fixtureEnvironment;
      for (const key of Object.keys(ctx.env)) delete ctx.env[key];
      Object.assign(ctx.env, isolatedEnvironment({}, root, plan.composition.fixture.app, endpoints[1]), { HOME: plan.identity.home });
      // Restore the actual sealed fixture routes after constructing the private environment.
      Object.assign(ctx.env, routes);
      const startup = shellStartup(ctx.env, { fixtureMode: true, target: "m1-gate", launcherMode: true });
      for (const path of [".zshenv", ".zlogin"]) create(root + "/zdot/" + path, startup);
    },
    shell: ctx => verifyFixtureShell(ctx.fixtureInstall, ctx.env, exec, fixtureIO),
    preferences: async ctx => {
      verifyClosePreferences(exec);
      const beforeWrite = await ctx.captureOwned();
      for (const effect of plan.effects.filter(row => ["setting", "marker"].includes(row.kind) && !same(row.before, row.owned))) if (!same(beforeWrite.resources[effect.id], effect.before)) throw Error("named effect changed before owned write");
      for (const effect of plan.effects.filter(row => row.kind === "setting" && !same(row.before, row.owned))) {
        if (typeof effect.owned.value !== "string") throw Error("named setting value must be string");
        exec("/usr/bin/defaults", ["write", effect.owned.domain, effect.owned.key, "-string", effect.owned.value], { env: ctx.env });
      }
      for (const effect of plan.effects.filter(row => row.kind === "marker" && !same(row.before, row.owned))) {
        const value = endpoints[1]; if (sha(value) !== effect.owned.hash || !effect.before) throw Error("exact existing known-marker value required");
        const fd = fs.openSync(effect.id, constants.O_WRONLY | constants.O_NOFOLLOW);
        try { const st = fs.fstatSync(fd); if (st.uid !== 501 || st.dev !== effect.before.dev || st.ino !== effect.before.ino || st.nlink !== 1) throw Error("known marker identity changed"); fs.writeFileSync(fd, value); fs.ftruncateSync(fd, Buffer.byteLength(value)); } finally { fs.closeSync(fd); }
      }
    },
    refreshAndQuit: async ctx => { await ctx.captureOwned(); }, // Observation endpoints are inputs: never quit/relaunch their app.
    launch: async (ctx, signal) => {
      // Only the armed producer can request an exclusive, descriptor-witnessed file creation.
      // A path read, process/native ACK or postcreation snapshot cannot manufacture this ACK.
      const disarm = providers?.armLaunchFiles?.((path, bytes) => {
        if (failed || closed || signal.aborted || !paths.some(row => row.stage === "launch" && row.kind === "file" && row.path === path) ||
            !(typeof bytes === "string" || Buffer.isBuffer(bytes)) || Buffer.byteLength(bytes) > 16 * 1024 * 1024 || filesystemAcks.has(path)) throw Error("launch file creation capability rejected");
        create(path, bytes);
        ledger.push({ stage: "launch", status: "FILE_CREATED", identity: structuredClone(filesystemAcks.get(path)) });
      });
      if (providers?.armLaunchFiles && typeof disarm !== "function") throw Error("launch file creation disarm required");
      let launchError;
      try {
        const entry = root + "/candidate/dist/daemon.js", child = fixtureIO.spawnProcess(plan.runtime.node, [entry], { cwd: plan.sourceManifest.root, env: { ...ctx.env, HOME: root + "/home" }, stdio: ["ignore", "ignore", "ignore"] });
        ledger.push({ stage: "launch", status: "DISPATCHED", kind: "process", pid: Number.isSafeInteger(child.pid) ? child.pid : null, trusted: false });
        await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); signal.addEventListener("abort", () => reject(Error("spawn ACK lost")), { once: true }); });
        ledger.push({ stage: "launch", status: "ACK_RECEIVED", kind: "process", pid: Number.isSafeInteger(child.pid) ? child.pid : null, trusted: false });
        if (!Number.isSafeInteger(child.pid) || child.pid <= 1) throw Error("creation spawn ACK invalid");
        if (signal.aborted || failed || closed) throw Error("launch file generation aborted before fixture dispatch");
        const daemon = { pid: child.pid, entry, argv: plan.runtime.node + " " + entry };
        pending = [{ id: "pid:" + child.pid, kind: "process", owned: daemon }, { id: root + "/d.sock", kind: "socket", owned: { pid: child.pid } }];
        const ack = await ctx.launchFixture((command, args, options) => request(endpoints[1], "workspace.create", { window_id: spec.window, cwd: options.cwd,
          initial_command: [command, ...args].map(quote).join(" "), initial_env: options.env }, { signal, timeoutMs: 3000, maxBytes: 1024 * 1024 }));
        if (failed || closed || signal.aborted) { ledger.push({ stage: "launch", status: "LATE_ACK_REJECTED", workspace: uuid(ack?.workspace_id) ? ack.workspace_id : null, trusted: false }); throw Error("late workspace ACK rejected"); }
        ledger.push({ stage: "launch", status: "ACK_RECEIVED", kind: "workspace", workspace: uuid(ack?.workspace_id) ? ack.workspace_id : null, window: uuid(ack?.window_id) ? ack.window_id : null, trusted: false });
        if (!uuid(ack?.workspace_id) || ack.window_id !== spec.window) throw Error("fixture workspace ACK unavailable");
        const membership = await request(endpoints[1], "workspace.list", { window_id: spec.window }, { signal, timeoutMs: 3000, maxBytes: 1024 * 1024 });
        if (membership?.window_id !== spec.window || !Array.isArray(membership.workspaces) || membership.workspaces.length > 1024 ||
            membership.workspaces.filter(row => row.id === ack.workspace_id).length !== 1) throw Error("workspace ACK independent window membership unavailable/ambiguous");
        let event;
        while (!signal.aborted) {
          if (fs.existsSync(root + "/d.sock") && fs.existsSync(root + "/ratchet-events.json") && fs.existsSync(root + "/state/daemon.log")) {
            const bytes = fs.readFileSync(root + "/ratchet-events.json"); if (bytes.length > 16384) throw Error("fixture event limit");
            try { event = JSON.parse(bytes); } catch { throw Error("fixture event JSON invalid"); }
            if (event.phase === "idle") break;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (signal.aborted || !event || event.draft !== "" || event.submitted !== "" || event.keys?.length !== 0 || event.submissions?.length !== 0) throw Error("fixture initial ACK unavailable/dirty");
        if (event.row !== plan.composition.fixture.row || event.workspace !== ack.workspace_id || !uuid(event.surface) ||
            !same(event.argv, [plan.runtime.node, fixtureIO.tui, event.row, root + "/ratchet-events.json"])) throw Error("fixture event/creation ACK mismatch");
        ledger.push({ stage: "launch", status: "ACK_RECEIVED", kind: "fixture", pid: Number.isSafeInteger(event.pid) ? event.pid : null, workspace: event.workspace, surface: event.surface, trusted: false });
        const fixture = { pid: event.pid, entry: fixtureIO.tui, argv: event.argv.join(" ") };
        pending.push({ id: "pid:" + fixture.pid, kind: "process", owned: fixture });
        await bind(ctx, "launch", [daemon, fixture], ack);
        const surface = owned.find(effect => effect.kind === "surface"); if (surface?.owned.uuid !== event.surface) throw Error("fixture surface independently unbound");
      } catch (error) { launchError = error; throw error; }
      finally { try { disarm?.(); } catch (error) { if (!launchError) throw error; ledger.push({ stage: "launch", status: "DISARM_FAILED" }); } }
    },
  };
  return { lifecycle, ...Object.fromEntries(stages.map(name => [name, async ctx => {
    if (failed || closed || attempts.has(name) || stages[next] !== name || !baseline) return fail(Error("owned stage order/no-replay violation"));
    attempts.add(name); ledger.push({ stage: name, status: "ATTEMPTED" });
    try {
      for (const path of paths.filter(row => row.stage === name)) if (current.resources[path.path] || fs.existsSync(path.path)) throw Error("creation precondition absent/foreign");
      await bounded(async signal => { await mutate[name](ctx, signal); if (name !== "launch") await bind(ctx, name); });
      next++;
    } catch (error) { ledger.push({ stage: name, status: "UNCERTAIN" }); return fail(error); }
  }])) };
}
