// Explicit controller composition. Import never connects, stages or launches anything.
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import { startSoakRuntime } from "../soak-runtime.mjs";
import { runAccountDriver } from "./account-observer-bridge.mjs";
import { happycamprContract, validateHappycamprPlan } from "./happycampr-effects.mjs";
import { createHappycamprSnapshotAdapter } from "./happycampr-runtime.mjs";
import { admissionStages } from "./app-admission.mjs";
import { installFixtureLaunchers, verifyFixtureLaunchers, launchFixtureSession, fixtureLaunchArgs } from "./fixture-launchers.mjs";
import { fileDigest } from "./fixture-attestation.mjs";
const canonical = value => JSON.stringify(value, (_key, row) => row && typeof row === "object" && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const keys = (row, expected) => row && !Array.isArray(row) && Object.keys(row).sort().join() === [...expected].sort().join();
const stages = [...admissionStages, "refreshAndQuit", "launch"];

export function createBoundTopologyReader(plan, source) {
  const peer = plan.composition?.topologyPeer, process = peer?.process, socket = peer?.socket;
  if (!source || typeof source.observePeer !== "function" || typeof source.readTopology !== "function" ||
      peer?.epoch !== plan.observerEpoch || !same(peer.product, plan.binding.product) ||
      !Number.isSafeInteger(process?.pid) || process.pid <= 1 || process.uid !== 501 || typeof process.start !== "string" || !process.start ||
      process.executable !== plan.runtime.node || process.entry !== plan.scratch.path + "/candidate/dist/" + (plan.composition.transport === "private-daemon-v1" ? "daemon.js" : "index.js") ||
      socket?.uid !== 501 || socket.mode !== 0o600 || !Number.isSafeInteger(socket.dev) || !Number.isSafeInteger(socket.ino) ||
      typeof socket.path !== "string" || posix.normalize(socket.path) !== socket.path || !socket.path.startsWith(plan.scratch.path + "/")) throw Error("bound independent topology adapter required");
  return async () => {
    const before = structuredClone(await source.observePeer());
    if (!same(before, peer)) throw Error("topology peer/source/product/socket identity mismatch");
    // No requested IDs or request arguments are passed back as observation evidence.
    const raw = await source.readTopology();
    if (!keys(raw, ["complete", "epoch", "workspaces", "surfaces", "focus"]) || raw.complete !== true || raw.epoch !== peer.epoch ||
        Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024 ||
        !Array.isArray(raw.workspaces) || raw.workspaces.length > 1024 || !Array.isArray(raw.surfaces) || raw.surfaces.length > 1024 ||
        raw.workspaces.some(row => !keys(row, ["uuid"])) || raw.surfaces.some(row => !keys(row, ["uuid", "workspace"])) ||
        !keys(raw.focus, ["workspace", "surface"])) throw Error("complete minimal topology observation unavailable");
    const topology = structuredClone({ epoch: raw.epoch, workspaces: raw.workspaces, surfaces: raw.surfaces, focus: raw.focus });
    if (!same(before, await source.observePeer())) throw Error("topology peer changed during observation");
    return topology; // Every member goes to the accepted R1 relationship validator.
  };
}

export async function runFixtureController(cfg, adapters = {}) {
  if (cfg?.accountContract !== happycamprContract) return runAccountDriver(cfg, adapters);
  const plan = structuredClone(cfg.happycamprPlan), expected = structuredClone(cfg.expectedBinding);
  validateHappycamprPlan(plan, expected);
  const io = adapters.io, fixtureIO = adapters.fixtureIO, fixture = plan.composition?.fixture;
  if (cfg.target !== "m1-gate" || cfg.fixtureMode !== true || cfg.humanSessionQuitApproved ||
      plan.executionApproved !== true || plan.nativeApproved !== true || plan.zeroModel !== true ||
      !io || ["identity", "runtimeIdentity", "query"].some(name => typeof io[name] !== "function") || !io.fs ||
      !fixtureIO || fixtureIO.fs !== io.fs || typeof fixtureIO.spawnProcess !== "function" || typeof fixtureIO.uid !== "function" ||
      ["realpathSync", "readFileSync", "lstatSync", "readdirSync", "mkdirSync", "writeFileSync", "existsSync"].some(name => typeof io.fs[name] !== "function") ||
      fixtureIO.node !== plan.runtime.node || fixtureIO.helper !== plan.sourceManifest.root + "/scripts/xmac/fixture-launchers.mjs" ||
      fixtureIO.tui !== plan.sourceManifest.root + "/scripts/ratchet-fixture-tui.mjs" ||
      (adapters.modulePath ?? fileURLToPath(import.meta.url)) !== plan.sourceManifest.root + "/scripts/xmac/happycampr-controller.mjs" ||
      !/^[a-f0-9]{64}$/.test(plan.sourceManifest.files["scripts/xmac/happycampr-controller.mjs"]) ||
      !fixture || !["banner", "boot", "contract"].includes(fixture.row) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(fixture.repo ?? "") ||
      typeof fixture.app !== "string" || !fixture.app.startsWith(plan.scratch.path + "/") || fixture.cwd !== plan.sourceManifest.root ||
      !Array.isArray(fixture.args) || !adapters.env || adapters.env.HOME !== plan.identity.home ||
      !adapters.stages || stages.some(name => typeof adapters.stages[name] !== "function")) throw Error("explicit501 controller adapters/configuration required");
  const parsed = fixtureLaunchArgs("codex", fixture.args);
  if (parsed.cwd && parsed.cwd !== fixture.cwd) throw Error("reviewed fixture launch cwd mismatch");
  if (fixtureIO.uid() !== 501 || fileDigest(fixtureIO.node, fixtureIO) !== plan.runtime.sha256) throw Error("fixture account/Node witness mismatch");
  const topology = createBoundTopologyReader(plan, adapters.topology);
  const env = { ...adapters.env }; let install, activeStage, launched = false;
  const lifecycle = adapters.stages.lifecycle;
  const ownedIO = { ...io, topology, lifecycle };
  const context = {
    env,
    captureOwned: () => createHappycamprSnapshotAdapter(plan, expected, ownedIO).capture(),
    get fixtureEnvironment() { return Object.fromEntries(Object.entries(env).filter(([key]) => /^(CMUXLAYER_(LAUNCHER|REQUIRE|FIXTURE|SESSION|XMAC)|CMUX_CUSTOM_|PATH)/.test(key))); },
    installFixture: () => {
      if (activeStage !== "fixture" || install) throw Error("fixture installation order/no-replay violation");
      const ownedFs = lifecycle?.creationFs ?? fixtureIO.fs;
      install = installFixtureLaunchers(env, { repo: fixture.repo, fixtureRow: fixture.row, app: fixture.app }, plan.scratch.path, fixture.cwd, { ...fixtureIO, fs: ownedFs });
      verifyFixtureLaunchers(install, env, fixtureIO);
      return install;
    },
    run: plan.run, effects: structuredClone(plan.effects),
    get fixtureInstall() { return install && structuredClone(install); },
    launchFixture: dispatch => {
      if (activeStage !== "launch" || launched || !install) throw Error("fixture launch order/single-dispatch violation");
      verifyFixtureLaunchers(install, env, fixtureIO);
      launched = true; // Ambiguous or failed dispatch is never replayed.
      return launchFixtureSession(install, env, "codex", parsed.cwd ? fixture.args : ["-w", fixture.cwd, ...fixture.args], dispatch && lifecycle ? { ...fixtureIO, spawnProcess: dispatch } : fixtureIO);
    },
  };
  const ownedStages = Object.fromEntries(stages.map(name => [name, async () => {
    activeStage = name;
    try {
      if (name === "fixture" && !lifecycle) {
        install = installFixtureLaunchers(env, { repo: fixture.repo, fixtureRow: fixture.row, app: fixture.app }, plan.scratch.path, fixture.cwd, fixtureIO);
        verifyFixtureLaunchers(install, env, fixtureIO);
        if (install.attestation.files.node.sha256 !== plan.runtime.sha256) throw Error("fixture Node witness mismatch");
      }
      if (name === "environment" && lifecycle && !install) throw Error("owned fixture installation missing");
      if (["environment", "shell", "preferences", "refreshAndQuit", "launch"].includes(name)) verifyFixtureLaunchers(install, env, fixtureIO);
      const value = await adapters.stages[name](context);
      if (name === "launch" && !launched) throw Error("fixture launcher dispatch missing");
      return value;
    } finally { activeStage = null; }
  }]));
  const instance = await startSoakRuntime({ ...cfg, happycamprPlan: plan, expectedBinding: expected, happycamprIO: ownedIO, happycamprStages: ownedStages });
  return { receipt: instance.receipt, close: instance.close, get fixtureInstall() { return install && structuredClone(install); } };
}
