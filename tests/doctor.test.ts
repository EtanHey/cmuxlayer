import net from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkMcpConfigDrift,
  detectRuntimeProvenance,
  parseSystemSleepPrevented,
  realCmuxVersionRunner,
  runDoctor,
  renderDoctorText,
  renderDoctorJson,
  type BrewRunner,
  type DoctorReport,
} from "../src/doctor.js";

/**
 * A brew stub: returns canned results keyed on the first meaningful arg.
 * `found: false` simulates "brew not found" (ENOENT).
 */
function makeBrew(opts: {
  found?: boolean;
  tapList?: string;
  infoOk?: boolean;
}): BrewRunner {
  const { found = true, tapList = "", infoOk = true } = opts;
  return async (args: string[]) => {
    if (!found) {
      return { ok: false, stdout: "", stderr: "", notFound: true };
    }
    if (args[0] === "tap") {
      return { ok: true, stdout: tapList, stderr: "" };
    }
    if (args[0] === "info") {
      return infoOk
        ? {
            ok: true,
            stdout: "etanhey/layers/cmuxlayer: stable 0.3.0",
            stderr: "",
          }
        : { ok: false, stdout: "", stderr: "Error: No available formula" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

const PMSET_RED_FIXTURE = `
Assertion status system-wide:
   BackgroundTask                 0
   ApplePushServiceTask           0
   UserIsActive                   1
   PreventUserIdleDisplaySleep    1
   PreventSystemSleep             1
   PreventUserIdleSystemSleep     0
`;

const PMSET_GREEN_FIXTURE = `
Assertion status system-wide:
   BackgroundTask                 0
   ApplePushServiceTask           0
   UserIsActive                   1
   PreventUserIdleDisplaySleep    1
   PreventSystemSleep             1
   PreventUserIdleSystemSleep     1
   pid 17232(caffeinate): [0x0000000100008001] 00:04:14 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
`;

const emptyPmset = async () => ({ ok: true, stdout: "", stderr: "" });
const missingLaunchctl = async () => ({
  ok: false,
  stdout: "",
  stderr: "service not found",
  notFound: true,
});

function mcpConfig(content: unknown): string {
  return JSON.stringify(content);
}

function fakeMcpConfigReaders(files: Record<string, string>) {
  return {
    listMcpConfigPaths: async () => [
      ...Object.keys(files),
      "/Users/etanheyman/Gits/missing/.mcp.json",
    ],
    readMcpConfigFile: async (path: string) => {
      if (!(path in files)) {
        throw new Error("missing");
      }
      return files[path];
    },
  };
}

function runDoctorForTest(opts: Parameters<typeof runDoctor>[0]) {
  return runDoctor({
    pmset: emptyPmset,
    launchctl: missingLaunchctl,
    listMcpConfigPaths: async () => [],
    readMcpConfigFile: async () => "",
    cmuxVersion: async () => ({
      ok: false,
      stdout: "",
      stderr: "cmux version unavailable in test",
    }),
    ...opts,
    env: {
      CMUXLAYER_DAEMON_SOCKET: join(
        "/tmp",
        `cmuxlayer-doctor-no-daemon-${process.pid}.sock`,
      ),
      ...opts.env,
    },
  });
}

const doctorServers: Array<{
  server: net.Server;
  path: string;
  sockets: Set<net.Socket>;
}> = [];
const doctorTempDirs: string[] = [];

afterEach(async () => {
  for (const { server, path, sockets } of doctorServers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
  for (const path of doctorTempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function launcherFixture(
  kind: "missing" | "dangling" | "non-executable" | "healthy",
): string {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-doctor-launcher-"));
  doctorTempDirs.push(root);
  const binDir = join(root, ".golems", "bin");
  mkdirSync(binDir, { recursive: true });
  const launcherPath = join(binDir, "cmuxlayer-mcp");
  if (kind === "missing") return launcherPath;
  if (kind === "dangling") {
    symlinkSync(join(root, "missing-target"), launcherPath);
    return launcherPath;
  }

  const target = join(root, "cmuxlayer-mcp-target");
  writeFileSync(target, "#!/bin/sh\nexit 0\n");
  chmodSync(target, kind === "healthy" ? 0o755 : 0o644);
  symlinkSync(target, launcherPath);
  return launcherPath;
}

async function startDoctorDaemon(
  path: string,
  opts: {
    version?: string;
    degraded?: boolean;
    cmuxSocketPath?: string;
    unresponsive?: boolean;
    ps?: string;
    scriptPath?: string;
    selfHeal?: {
      pane_pty_dead: {
        count: number;
        surfaces: Array<{ surface_id: string; since_at: string }>;
        truncated: boolean;
      };
      monitor_registry: {
        total: number;
        rearming: number;
        collapsed: number;
        collapsed_monitors: Array<{ monitor_id: string; reason: string }>;
        truncated: boolean;
      };
    };
  } = {},
): Promise<void> {
  rmSync(path, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (opts.unresponsive) return;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: string | number;
          method?: string;
          params?: { name?: string };
        };
        if (message.method === "initialize") {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: {
                  name: "cmuxlayer",
                  version: opts.version ?? "0.3.33",
                },
              },
            })}\n`,
          );
        } else if (
          message.method === "tools/call" &&
          message.params?.name === "control_health"
        ) {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [],
                structuredContent: {
                  health: {
                    current_process: {
                      ps: opts.ps ?? "",
                      script_path: opts.scriptPath ?? null,
                    },
                    selected_transport: {
                      transport_mode: opts.degraded ? "cli" : "socket",
                      transport_degraded: opts.degraded ?? false,
                      current_socket_path:
                        opts.cmuxSocketPath ?? "/tmp/cmux-test.sock",
                    },
                    ...(opts.selfHeal
                      ? {
                          self_heal: {
                            ...opts.selfHeal,
                            pane_pty_dead: {
                              ...opts.selfHeal.pane_pty_dead,
                              surfaces:
                                opts.selfHeal.pane_pty_dead.surfaces.map(
                                  (surface) => ({
                                    ...surface,
                                    last_attempt_at: surface.since_at,
                                  }),
                                ),
                            },
                            monitor_registry: {
                              available: true,
                              ...opts.selfHeal.monitor_registry,
                            },
                          },
                        }
                      : {}),
                  },
                },
              },
            })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  doctorServers.push({ server, path, sockets });
}

describe("runDoctor — report shape", () => {
  it("reads the selected cmux app CLI version when available", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-cmux-version-"));
    doctorTempDirs.push(root);
    const cmuxBin = join(root, "cmux");
    writeFileSync(
      cmuxBin,
      "#!/bin/sh\nprintf '%s\\n' 'cmux 0.64.17 (97) [test]'\n",
    );
    chmodSync(cmuxBin, 0o755);

    await expect(
      realCmuxVersionRunner({
        ...process.env,
        CMUX_BUNDLED_CLI_PATH: cmuxBin,
      }),
    ).resolves.toMatchObject({
      ok: true,
      stdout: "cmux 0.64.17 (97) [test]\n",
    });
  });

  it("reports tested cmux app versions as informational", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
      cmuxVersion: async () => ({
        ok: true,
        stdout: "cmux 0.64.17 (97) [9ed29d81a]",
        stderr: "",
      }),
    });

    expect(report.cmuxCompatibility).toMatchObject({
      available: true,
      liveVersion: "0.64.17",
      severity: "info",
      tested: true,
      testedVersions: ["0.64.17", "0.64.14-nightly"],
    });
    expect(report.cmuxCompatibility.note).toMatch(
      /running cmux v0\.64\.17; tested against v0\.64\.17, v0\.64\.14-nightly/i,
    );
    expect(report.healthy).toBe(true);
  });

  it("warns without failing health when the live cmux app version is untested", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
      cmuxVersion: async () => ({
        ok: true,
        stdout: "cmux 0.65.0 (101) [abcdef]",
        stderr: "",
      }),
    });

    expect(report.cmuxCompatibility).toMatchObject({
      available: true,
      liveVersion: "0.65.0",
      severity: "warn",
      tested: false,
    });
    expect(report.cmuxCompatibility.note).toMatch(
      /running cmux v0\.65\.0; tested against v0\.64\.17, v0\.64\.14-nightly — behavior unverified/i,
    );
    expect(report.healthy).toBe(true);
  });

  it("accepts build-qualified versions from the tested nightly line", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
      cmuxVersion: async () => ({
        ok: true,
        stdout: "cmux 0.64.14-nightly.2912634120001 (2912634120001) [abcdef]",
        stderr: "",
      }),
    });

    expect(report.cmuxCompatibility.tested).toBe(true);
    expect(report.cmuxCompatibility.severity).toBe("info");
    expect(report.healthy).toBe(true);
  });

  it("does not broaden a tested production version into a version family", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
      cmuxVersion: async () => ({
        ok: true,
        stdout: "cmux 0.64.17.1 (98) [abcdef]",
        stderr: "",
      }),
    });

    expect(report.cmuxCompatibility.tested).toBe(false);
    expect(report.cmuxCompatibility.severity).toBe("warn");
    expect(report.healthy).toBe(true);
  });

  it("reports the version when it resolves", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.version.ok).toBe(true);
    expect(report.version.value).toBe("0.3.0");
  });

  it("flags an unknown version as not-ok", async () => {
    const report = await runDoctorForTest({
      version: "unknown",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.version.ok).toBe(false);
  });

  it("marks §1 account-rename self-heal as not-applicable (stdio MCP, no cask)", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.caskSelfHeal.applicable).toBe(false);
    expect(report.caskSelfHeal.note).toMatch(/not-applicable/i);
    expect(report.caskSelfHeal.note).toMatch(/stdio MCP/i);
    expect(report.caskSelfHeal.note).toMatch(/no cask/i);
  });

  it("reports no daemon as healthy because it starts on demand", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.daemon.applicable).toBe(true);
    expect(report.daemon.ok).toBe(true);
    expect(report.daemon.listening).toBe(false);
    expect(report.daemon.note).toMatch(/no daemon running.*starts on demand/i);
  });

  it("reports a healthy matching daemon", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-healthy-${process.pid}.sock`);
    await startDoctorDaemon(path, { version: "0.3.33" });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: ({ running }) => ({
        stale: false,
        running: running ?? "unknown",
        installed: "0.3.33",
      }),
    });

    expect(report.daemon).toMatchObject({
      applicable: true,
      ok: true,
      listening: true,
      runningVersion: "0.3.33",
      installedVersion: "0.3.33",
    });
    expect(report.healthy).toBe(true);
  });

  it("reports pane_pty_dead surfaces from daemon control_health", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-pty-dead-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      selfHeal: {
        pane_pty_dead: {
          count: 1,
          surfaces: [
            {
              surface_id: "surface:pty-dead",
              since_at: "2026-07-11T12:00:01.000Z",
            },
          ],
          truncated: false,
        },
        monitor_registry: {
          total: 2,
          rearming: 0,
          collapsed: 0,
          collapsed_monitors: [],
          truncated: false,
        },
      },
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: () => null,
    });

    expect(report.selfHeal).toMatchObject({ available: true, ok: false });
    expect(report.healthy).toBe(false);
    expect(renderDoctorText(report)).toMatch(
      /✗.*pane_pty_dead.*surface:pty-dead.*2026-07-11T12:00:01.000Z/i,
    );
  });

  it("reports collapsed monitors with their reasons from daemon control_health", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-collapsed-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      selfHeal: {
        pane_pty_dead: { count: 0, surfaces: [], truncated: false },
        monitor_registry: {
          total: 3,
          rearming: 1,
          collapsed: 1,
          collapsed_monitors: [
            {
              monitor_id: "monitor-collapsed",
              reason: "owner-not-alive",
            },
          ],
          truncated: false,
        },
      },
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: () => null,
    });

    expect(report.selfHeal).toMatchObject({ available: true, ok: false });
    expect(report.healthy).toBe(false);
    expect(renderDoctorText(report)).toMatch(
      /✗.*collapsed monitors.*monitor-collapsed: owner-not-alive/i,
    );
  });

  it("reports healthy pane liveness and monitor reconciliation state", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-self-heal-green-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      selfHeal: {
        pane_pty_dead: { count: 0, surfaces: [], truncated: false },
        monitor_registry: {
          total: 4,
          rearming: 1,
          collapsed: 0,
          collapsed_monitors: [],
          truncated: false,
        },
      },
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: () => null,
    });

    expect(report.selfHeal).toMatchObject({ available: true, ok: true });
    expect(report.healthy).toBe(true);
    expect(renderDoctorText(report)).toMatch(/✔.*pane_pty_dead: none/i);
    expect(renderDoctorText(report)).toMatch(
      /✔.*monitor registry: total=4 rearming=1 collapsed=0/i,
    );
  });

  it("rejects impossible monitor summary counters as unavailable", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-self-heal-invalid-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      selfHeal: {
        pane_pty_dead: { count: 0, surfaces: [], truncated: false },
        monitor_registry: {
          total: 1,
          rearming: 2,
          collapsed: 0,
          collapsed_monitors: [],
          truncated: false,
        },
      },
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: () => null,
    });

    expect(report.selfHeal).toMatchObject({
      available: false,
      ok: true,
      note: expect.stringMatching(/malformed/i),
    });
  });

  it("preserves and renders truncation when daemon detail arrays exceed the bound", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-self-heal-truncated-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      selfHeal: {
        pane_pty_dead: {
          count: 101,
          surfaces: Array.from({ length: 101 }, (_, index) => ({
            surface_id: `surface:${index}`,
            since_at: "2026-07-11T12:00:01.000Z",
          })),
          truncated: false,
        },
        monitor_registry: {
          total: 101,
          rearming: 0,
          collapsed: 101,
          collapsed_monitors: Array.from({ length: 101 }, (_, index) => ({
            monitor_id: `monitor:${index}`,
            reason: "owner-not-alive",
          })),
          truncated: false,
        },
      },
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: () => null,
    });

    expect(report.selfHeal.panePtyDead).toMatchObject({
      count: 101,
      truncated: true,
    });
    expect(report.selfHeal.panePtyDead.surfaces).toHaveLength(100);
    expect(report.selfHeal.monitorRegistry).toMatchObject({
      collapsed: 101,
      truncated: true,
    });
    expect(report.selfHeal.monitorRegistry.collapsedMonitors).toHaveLength(100);
    expect(renderDoctorText(report)).toMatch(/pane_pty_dead: 101.*truncated/i);
    expect(renderDoctorText(report)).toMatch(
      /collapsed monitors:.*truncated/i,
    );
  });

  it("rejects self-heal counters that contradict their detail rows", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-self-heal-contradiction-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      selfHeal: {
        pane_pty_dead: {
          count: 0,
          surfaces: [
            {
              surface_id: "surface:unexpected",
              since_at: "2026-07-11T12:00:01.000Z",
            },
          ],
          truncated: false,
        },
        monitor_registry: {
          total: 1,
          rearming: 0,
          collapsed: 0,
          collapsed_monitors: [
            {
              monitor_id: "monitor:unexpected",
              reason: "owner-not-alive",
            },
          ],
          truncated: false,
        },
      },
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: () => null,
    });

    expect(report.selfHeal).toMatchObject({
      available: false,
      note: expect.stringMatching(/malformed/i),
    });
  });

  it("flags a stale daemon version mismatch", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-stale-${process.pid}.sock`);
    await startDoctorDaemon(path, { version: "0.3.31" });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: ({ running }) => ({
        stale: true,
        running: running ?? "unknown",
        installed: "0.3.33",
      }),
    });

    expect(report.daemon.ok).toBe(false);
    expect(report.daemon.note).toMatch(
      /stale daemon v0\.3\.31 serving \(installed v0\.3\.33\).*proxies respawn/i,
    );
    expect(report.healthy).toBe(false);
  });

  it("flags a daemon whose running script was deleted by brew cleanup", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-deleted-${process.pid}.sock`);
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-doctor-deleted-tree-"));
    doctorTempDirs.push(root);
    const oldRoot = join(root, "Cellar", "cmuxlayer", "0.3.31");
    const newRoot = join(root, "Cellar", "cmuxlayer", "0.3.35");
    const optRoot = join(root, "opt", "cmuxlayer");
    const relativeScript = join("libexec", "dist", "daemon.js");
    mkdirSync(join(oldRoot, "libexec", "dist"), { recursive: true });
    mkdirSync(join(newRoot, "libexec", "dist"), { recursive: true });
    mkdirSync(dirname(optRoot), { recursive: true });
    writeFileSync(join(oldRoot, relativeScript), "");
    writeFileSync(join(newRoot, relativeScript), "");
    symlinkSync(oldRoot, optRoot, "dir");
    const runningScript = realpathSync(join(optRoot, relativeScript));
    rmSync(optRoot);
    symlinkSync(newRoot, optRoot, "dir");
    rmSync(oldRoot, { recursive: true, force: true });

    expect(existsSync(join(optRoot, relativeScript))).toBe(true);
    expect(existsSync(runningScript)).toBe(false);
    await startDoctorDaemon(path, {
      version: "0.3.31",
      ps: `123 1 123 0 S ?? node ${join(optRoot, relativeScript)}`,
      scriptPath: runningScript,
    });

    const report = await runDoctorForTest({
      version: "0.3.35",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: () => null,
    });

    expect(report.daemon.ok).toBe(false);
    expect(report.daemon.note).toBe(
      "daemon running from a deleted install (brew cleanup?) — stale detection is blind; retire it",
    );
    expect(report.healthy).toBe(false);
  });

  it("flags degraded daemon transport while the reported cmux socket is live", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-degraded-${process.pid}.sock`);
    const cmuxPath = join("/tmp", `cmuxlayer-doctor-live-cmux-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      degraded: true,
      cmuxSocketPath: cmuxPath,
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: ({ running }) => ({
        stale: false,
        running: running ?? "unknown",
        installed: "0.3.33",
      }),
      probeCmuxSocket: async (socketPath) => ({
        usable: socketPath === cmuxPath,
        socketPath,
      }),
    });

    expect(report.daemon.ok).toBe(false);
    expect(report.daemon.note).toMatch(
      /daemon transport degraded while cmux socket alive.*stale-daemon-on-dead-socket class/i,
    );
    expect(report.healthy).toBe(false);
  });

  it("never reports a degraded daemon healthy when the cmux socket is down", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-degraded-down-${process.pid}.sock`);
    const cmuxPath = join("/tmp", `cmuxlayer-doctor-down-cmux-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      degraded: true,
      cmuxSocketPath: cmuxPath,
    });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      detectStaleBuild: ({ running }) => ({
        stale: false,
        running: running ?? "unknown",
        installed: "0.3.33",
      }),
      probeCmuxSocket: async (socketPath) => ({
        usable: false,
        socketPath,
        error: "connect ECONNREFUSED",
      }),
    });

    expect(report.daemon.ok).toBe(false);
    expect(report.daemon.note).toMatch(
      /daemon transport degraded.*cmux socket down.*app not running/i,
    );
    expect(report.healthy).toBe(false);
  });

  it("probes the CMUX_SOCKET_PATH pin instead of the daemon-reported default", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-degraded-pin-${process.pid}.sock`);
    const reportedPath = join("/tmp", `cmuxlayer-doctor-reported-${process.pid}.sock`);
    const pinnedPath = join("/tmp", `cmuxlayer-doctor-pinned-${process.pid}.sock`);
    await startDoctorDaemon(path, {
      version: "0.3.33",
      degraded: true,
      cmuxSocketPath: reportedPath,
    });
    const probeCmuxSocket = vi.fn(async (socketPath: string) => ({
      usable: socketPath === pinnedPath,
      socketPath,
    }));

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: {
        CMUXLAYER_DAEMON_SOCKET: path,
        CMUX_SOCKET_PATH: pinnedPath,
      },
      brew: makeBrew({}),
      detectStaleBuild: ({ running }) => ({
        stale: false,
        running: running ?? "unknown",
        installed: "0.3.33",
      }),
      probeCmuxSocket,
    });

    expect(probeCmuxSocket).toHaveBeenCalledWith(pinnedPath);
    expect(probeCmuxSocket).not.toHaveBeenCalledWith(reportedPath);
    expect(report.daemon.ok).toBe(false);
    expect(report.daemon.note).toMatch(/access-control denial class/i);
  });

  it("flags a listening but unresponsive daemon with the probe error", async () => {
    const path = join("/tmp", `cmuxlayer-doctor-hung-${process.pid}.sock`);
    await startDoctorDaemon(path, { unresponsive: true });

    const report = await runDoctorForTest({
      version: "0.3.33",
      env: { CMUXLAYER_DAEMON_SOCKET: path },
      brew: makeBrew({}),
      daemonProbeTimeoutMs: 30,
    });

    expect(report.daemon).toMatchObject({
      applicable: true,
      ok: false,
      listening: true,
    });
    expect(report.daemon.note).toMatch(/timed out/i);
    expect(report.healthy).toBe(false);
  });

  it("reports the tap as present + formula resolvable when brew lists it", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({
        tapList: "homebrew/core\netanhey/layers\nfoo/bar\n",
        infoOk: true,
      }),
    });
    expect(report.tap.tapPresent).toBe(true);
    expect(report.tap.formulaResolves).toBe(true);
    expect(report.tap.note).toMatch(/CASKS need .*brew trust etanhey\/layers/i);
    expect(report.tap.note).toMatch(/formula, not gated/i);
  });

  it("reports the tap as absent when brew does not list it", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ tapList: "homebrew/core\n", infoOk: false }),
    });
    expect(report.tap.tapPresent).toBe(false);
  });

  it("degrades gracefully (does not throw / does not fail hard) when brew is not found", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ found: false }),
    });
    expect(report.tap.brewAvailable).toBe(false);
    expect(report.tap.note).toMatch(/brew not found/i);
    // brew unavailability must NOT make the doctor unhealthy.
    expect(report.healthy).toBe(true);
  });

  it("reports CMUX_SOCKET_PATH when set", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: { CMUX_SOCKET_PATH: "/tmp/cmux-501.sock" },
      brew: makeBrew({}),
    });
    expect(report.socketPath.set).toBe(true);
    expect(report.socketPath.value).toBe("/tmp/cmux-501.sock");
  });

  it("reports CMUX_SOCKET_PATH as unset (auto-discover) when absent", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.socketPath.set).toBe(false);
    expect(report.socketPath.note).toMatch(/unset \(auto-discover\)/i);
  });

  it("is healthy on a normal machine (version resolves)", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ tapList: "etanhey/layers\n" }),
    });
    expect(report.healthy).toBe(true);
  });

  it("reports sleep guard as non-durable without pmset assertion and launchd guard", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ tapList: "etanhey/layers\n" }),
      pmset: async () => ({ ok: true, stdout: PMSET_RED_FIXTURE, stderr: "" }),
      launchctl: async () => ({
        ok: false,
        stdout: "",
        stderr: "service not found",
        notFound: true,
      }),
    });

    expect(report.sleepGuard.systemSleepPrevented).toBe(false);
    expect(report.sleepGuard.keepAliveLoaded).toBe(false);
    expect(report.sleepGuard.durable).toBe(false);
    expect(report.sleepGuard.note).toMatch(/launchd\/cmux-caffeinate\/README\.md/);
    expect(report.healthy).toBe(true);
  });

  it("reports sleep guard as durable when pmset assertion is active and launchd guard is loaded", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ tapList: "etanhey/layers\n" }),
      pmset: async () => ({ ok: true, stdout: PMSET_GREEN_FIXTURE, stderr: "" }),
      launchctl: async () => ({
        ok: true,
        stdout: "gui/501/com.golems.cmux-caffeinate = {\n  active count = 1\n}",
        stderr: "",
      }),
    });

    expect(report.sleepGuard.systemSleepPrevented).toBe(true);
    expect(report.sleepGuard.keepAliveLoaded).toBe(true);
    expect(report.sleepGuard.durable).toBe(true);
    expect(report.sleepGuard.note).toMatch(/durable/i);
    expect(report.healthy).toBe(true);
  });

  it("includes .mcp.json drift without flipping health", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ tapList: "etanhey/layers\n" }),
      pmset: emptyPmset,
      launchctl: missingLaunchctl,
      ...fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/one/.mcp.json": mcpConfig({
          mcpServers: {
            cmuxlayer: {
              command: "node",
              args: ["/Users/etanheyman/Gits/cmuxlayer/dist/index.js"],
            },
          },
        }),
      }),
    });

    expect(report.healthy).toBe(true);
    expect(report.mcpConfigDrift.scanned).toBe(1);
    expect(report.mcpConfigDrift.drifted).toEqual([
      {
        path: "/Users/etanheyman/Gits/one/.mcp.json",
        serverKey: "cmuxlayer",
        reason: expect.stringMatching(/cmuxlayer-mcp/i),
      },
    ]);
  });

  it("marks doctor unhealthy when a referenced launcher is unusable", async () => {
    const launcherPath = launcherFixture("missing");
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
      ...fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/missing-launcher/.mcp.json": mcpConfig({
          mcpServers: { cmuxlayer: { command: launcherPath, args: [] } },
        }),
      }),
    });

    expect(report.healthy).toBe(false);
    expect(renderDoctorText(report)).toMatch(/✗ launcher:.*reinstall/i);
  });

  it("reports the running dist entrypoint path as runtime provenance", async () => {
    const report = await runDoctorForTest({
      version: "0.3.1",
      env: {},
      brew: makeBrew({}),
      runtimeProvenance: () =>
        detectRuntimeProvenance({
          argv: [
            "/opt/homebrew/opt/node/bin/node",
            "/opt/homebrew/Cellar/cmuxlayer/0.3.1/libexec/dist/index.js",
          ],
          env: {},
          execPath: "/opt/homebrew/opt/node/bin/node",
        }),
    });

    expect(report.runtimeProvenance).toMatchObject({
      distEntrypoint: true,
      entrypoint:
        "/opt/homebrew/Cellar/cmuxlayer/0.3.1/libexec/dist/index.js",
      mode: "dist",
      ok: true,
    });
    expect(report.runtimeProvenance.note).toMatch(/running dist\/index\.js/i);
    expect(report.healthy).toBe(true);
  });

  it("treats the Homebrew cmuxlayer bin entrypoint as trusted dist provenance", async () => {
    const report = await runDoctorForTest({
      version: "0.3.1",
      env: {},
      brew: makeBrew({}),
      runtimeProvenance: () =>
        detectRuntimeProvenance({
          argv: [
            "/opt/homebrew/opt/node/bin/node",
            "/opt/homebrew/bin/cmuxlayer",
          ],
          env: {},
          execPath: "/opt/homebrew/opt/node/bin/node",
        }),
    });

    expect(report.runtimeProvenance).toMatchObject({
      distEntrypoint: true,
      entrypoint: "/opt/homebrew/bin/cmuxlayer",
      mode: "dist",
      ok: true,
    });
    expect(report.runtimeProvenance.note).toMatch(/brew-installed cmuxlayer/i);
    expect(report.healthy).toBe(true);
  });

  it("surfaces live source runtime provenance without failing the doctor", async () => {
    const report = await runDoctorForTest({
      version: "0.3.1",
      env: { CMUXLAYER_DEV: "1" },
      brew: makeBrew({}),
      runtimeProvenance: () =>
        detectRuntimeProvenance({
          argv: [
            "/Users/etanheyman/.bun/bin/bun",
            "/Users/etanheyman/Gits/cmuxlayer/src/index.ts",
          ],
          env: { CMUXLAYER_DEV: "1" },
          execPath: "/Users/etanheyman/.bun/bin/bun",
        }),
    });

    expect(report.runtimeProvenance).toMatchObject({
      distEntrypoint: false,
      mode: "source",
      ok: false,
    });
    expect(report.runtimeProvenance.note).toMatch(/live source/i);
    expect(report.healthy).toBe(true);
  });

  it("keeps launcher runtime provenance ahead of the development env override", async () => {
    const report = await runDoctorForTest({
      version: "0.3.1",
      env: { CMUXLAYER_DEV: "1" },
      brew: makeBrew({}),
      runtimeProvenance: () =>
        detectRuntimeProvenance({
          argv: [
            "/opt/homebrew/opt/node/bin/node",
            "/Users/etanheyman/.golems/bin/cmuxlayer-mcp",
          ],
          env: { CMUXLAYER_DEV: "1" },
          execPath: "/opt/homebrew/opt/node/bin/node",
        }),
    });

    expect(report.runtimeProvenance).toMatchObject({
      distEntrypoint: false,
      entrypoint: "/Users/etanheyman/.golems/bin/cmuxlayer-mcp",
      mode: "launcher",
      ok: false,
    });
    expect(report.runtimeProvenance.note).toMatch(/launcher path/i);
    expect(report.healthy).toBe(true);
  });

  it("reports unknown runtime provenance without failing the doctor", async () => {
    const report = await runDoctorForTest({
      version: "0.3.1",
      env: {},
      brew: makeBrew({}),
      runtimeProvenance: () =>
        detectRuntimeProvenance({
          argv: [
            "/opt/homebrew/opt/node/bin/node",
            "/tmp/cmuxlayer-wrapper",
          ],
          env: {},
          execPath: "/opt/homebrew/opt/node/bin/node",
        }),
    });

    expect(report.runtimeProvenance).toMatchObject({
      distEntrypoint: false,
      entrypoint: "/tmp/cmuxlayer-wrapper",
      mode: "unknown",
      ok: false,
    });
    expect(report.runtimeProvenance.note).toMatch(/unknown/i);
    expect(report.healthy).toBe(true);
  });

  it("includes a manual MCP reconnect probe procedure in the doctor report", async () => {
    const report = await runDoctorForTest({
      version: "0.3.1",
      env: {},
      brew: makeBrew({}),
    });

    expect(report.mcpReconnectProcedure.automation).toBe(false);
    expect(report.mcpReconnectProcedure.note).toMatch(/\/mcp/);
    expect(report.mcpReconnectProcedure.note).toMatch(/Reconnect/);
    expect(report.mcpReconnectProcedure.note).toMatch(/cmuxlayer doctor/);
  });
});

describe("parseSystemSleepPrevented", () => {
  it("returns false when the aggregate PreventUserIdleSystemSleep line is 0", () => {
    expect(parseSystemSleepPrevented(PMSET_RED_FIXTURE)).toBe(false);
  });

  it("returns true when the aggregate PreventUserIdleSystemSleep line is 1", () => {
    expect(parseSystemSleepPrevented(PMSET_GREEN_FIXTURE)).toBe(true);
  });

  it("ignores caffeinate pid lines without the aggregate assertion line", () => {
    expect(
      parseSystemSleepPrevented(
        'pid 17232(caffeinate): [0x...] 00:04:14 PreventUserIdleSystemSleep named: "caffeinate command-line tool"',
      ),
    ).toBe(false);
  });
});

describe("checkMcpConfigDrift", () => {
  it("treats a launcher-pointing cmuxlayer entry as clean", async () => {
    const launcherPath = launcherFixture("healthy");
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/clean/.mcp.json": mcpConfig({
          mcpServers: {
            cmuxlayer: {
              command: launcherPath,
              args: [],
            },
          },
        }),
      }),
    );

    expect(report.scanned).toBe(1);
    expect(report.drifted).toEqual([]);
    expect(report.launcherOk).toBe(true);
    expect(report.launchers).toEqual([
      expect.objectContaining({ path: launcherPath, ok: true }),
    ]);
    expect(report.note).toMatch(/launcher/i);
  });

  it("flags a referenced launcher that is missing", async () => {
    const launcherPath = launcherFixture("missing");
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/missing-launcher/.mcp.json": mcpConfig({
          mcpServers: { cmuxlayer: { command: launcherPath, args: [] } },
        }),
      }),
    );

    expect(report.launcherOk).toBe(false);
    expect(report.drifted[0]?.reason).toMatch(/launcher.*missing/i);
    expect(report.drifted[0]?.reason).toMatch(/reinstall/i);
  });

  it("flags a referenced launcher with a dangling symlink", async () => {
    const launcherPath = launcherFixture("dangling");
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/dangling-launcher/.mcp.json": mcpConfig({
          mcpServers: { cmuxlayer: { command: launcherPath, args: [] } },
        }),
      }),
    );

    expect(report.launcherOk).toBe(false);
    expect(report.drifted[0]?.reason).toMatch(/dangling symlink/i);
  });

  it("flags a referenced launcher that is not executable", async () => {
    const launcherPath = launcherFixture("non-executable");
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/non-executable-launcher/.mcp.json": mcpConfig({
          mcpServers: { cmuxlayer: { command: launcherPath, args: [] } },
        }),
      }),
    );

    expect(report.launcherOk).toBe(false);
    expect(report.drifted[0]?.reason).toMatch(/not executable/i);
  });

  it("flags a cmuxlayer entry that bypasses the launcher via node dist/index.js", async () => {
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/drift/.mcp.json": mcpConfig({
          mcpServers: {
            cmuxlayer: {
              command: "node",
              args: ["/Users/etanheyman/Gits/cmuxlayer/dist/index.js"],
            },
          },
        }),
      }),
    );

    expect(report.scanned).toBe(1);
    expect(report.drifted).toEqual([
      {
        path: "/Users/etanheyman/Gits/drift/.mcp.json",
        serverKey: "cmuxlayer",
        reason: expect.stringMatching(/cmuxlayer-mcp/i),
      },
    ]);
  });

  it("does not treat unrelated paths containing cmuxlayer-mcp as the launcher", async () => {
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/substring/.mcp.json": mcpConfig({
          mcpServers: {
            cmuxlayer: {
              command: "node",
              args: ["/Users/etanheyman/Gits/cmuxlayer-mcp/dist/index.js"],
            },
          },
        }),
      }),
    );

    expect(report.scanned).toBe(1);
    expect(report.drifted).toEqual([
      {
        path: "/Users/etanheyman/Gits/substring/.mcp.json",
        serverKey: "cmuxlayer",
        reason: expect.stringMatching(/cmuxlayer-mcp/i),
      },
    ]);
  });

  it("flags the stale cmux server key even when it points at the launcher", async () => {
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/stale/.mcp.json": mcpConfig({
          mcpServers: {
            cmux: {
              command: "/Users/etanheyman/.golems/bin/cmuxlayer-mcp",
              args: [],
            },
          },
        }),
      }),
    );

    expect(report.scanned).toBe(1);
    expect(report.drifted).toEqual([
      {
        path: "/Users/etanheyman/Gits/stale/.mcp.json",
        serverKey: "cmux",
        reason: expect.stringMatching(/stale.*cmux/i),
      },
    ]);
  });

  it("ignores repos with no cmux or cmuxlayer server entry", async () => {
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/other/.mcp.json": mcpConfig({
          mcpServers: {
            other: { command: "node", args: ["server.js"] },
          },
        }),
      }),
    );

    expect(report.scanned).toBe(1);
    expect(report.drifted).toEqual([]);
  });

  it("skips missing and invalid JSON files without throwing", async () => {
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/valid/.mcp.json": mcpConfig({
          mcpServers: {},
        }),
        "/Users/etanheyman/Gits/invalid/.mcp.json": "{ not json",
      }),
    );

    expect(report.scanned).toBe(1);
    expect(report.drifted).toEqual([]);
  });
});

describe("renderDoctorText", () => {
  function baseReport(): DoctorReport {
    return {
      healthy: true,
      version: { ok: true, value: "0.3.0" },
      caskSelfHeal: {
        applicable: false,
        note: "not-applicable: stdio MCP, no cask (§1 account-rename self-heal)",
      },
      daemon: {
        applicable: true,
        ok: true,
        listening: false,
        note: "no daemon running (starts on demand)",
      },
      selfHeal: {
        available: false,
        ok: true,
        panePtyDead: { count: 0, surfaces: [], truncated: false },
        monitorRegistry: {
          available: false,
          total: 0,
          rearming: 0,
          collapsed: 0,
          collapsedMonitors: [],
          truncated: false,
        },
        note: "no daemon running (starts on demand)",
      },
      tap: {
        brewAvailable: true,
        tapPresent: true,
        formulaResolves: true,
        note: "tap CASKS need `brew trust etanhey/layers`; cmuxlayer is a formula, not gated",
      },
      socketPath: { set: false, value: null, note: "unset (auto-discover)" },
      cmuxCompatibility: {
        available: true,
        liveVersion: "0.64.17",
        severity: "info",
        tested: true,
        testedVersions: ["0.64.17", "0.64.14-nightly"],
        note: "running cmux v0.64.17; tested against v0.64.17, v0.64.14-nightly",
      },
      sleepGuard: {
        systemSleepPrevented: false,
        keepAliveLoaded: false,
        durable: false,
        note: "not durable; install launchd/cmux-caffeinate/README.md",
      },
      runtimeProvenance: {
        distEntrypoint: true,
        entrypoint:
          "/opt/homebrew/Cellar/cmuxlayer/0.3.1/libexec/dist/index.js",
        execPath: "/opt/homebrew/opt/node/bin/node",
        mode: "dist",
        nodeVersion: "v22.0.0",
        ok: true,
        note: "running dist/index.js",
      },
      mcpReconnectProcedure: {
        automation: false,
        note: "Manual probe: /mcp -> cmuxlayer -> Reconnect, then run cmuxlayer doctor --json.",
      },
      mcpConfigDrift: {
        scanned: 0,
        drifted: [],
        launcherOk: true,
        launchers: [],
        note: "scanned ~/Gits/*/.mcp.json for cmuxlayer launcher drift",
      },
    };
  }

  it("prints the version", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toContain("0.3.0");
  });

  it("prints the §1 not-applicable line explicitly (no silent no-op)", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/not-applicable: stdio MCP, no cask/i);
  });

  it("prints the §5 daemon integrity line", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/§5.*no daemon running.*starts on demand/i);
  });

  it("prints the tap status and the trust note for casks", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/brew trust etanhey\/layers/i);
    expect(text).toMatch(/formula, not gated/i);
  });

  it("prints the CMUX_SOCKET_PATH status", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/CMUX_SOCKET_PATH/);
    expect(text).toMatch(/unset \(auto-discover\)/i);
  });

  it("prints the cmux compatibility severity and note", () => {
    const text = renderDoctorText({
      ...baseReport(),
      cmuxCompatibility: {
        available: true,
        liveVersion: "0.65.0",
        severity: "warn",
        tested: false,
        testedVersions: ["0.64.17", "0.64.14-nightly"],
        note: "running cmux v0.65.0; tested against v0.64.17, v0.64.14-nightly — behavior unverified",
      },
    });
    expect(text).toMatch(/WARN.*running cmux v0\.65\.0/i);
  });

  it("prints sleep guard status and install hint when not durable", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/sleep guard/i);
    expect(text).toMatch(/launchd\/cmux-caffeinate\/README\.md/);
  });

  it("prints runtime provenance and the MCP reconnect probe procedure", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/runtime.*dist\/index\.js/i);
    expect(text).toMatch(/\/mcp.*Reconnect/i);
    expect(text).toMatch(/cmuxlayer doctor --json/i);
  });

  it("prints a no-drift line when no .mcp.json drift is detected", () => {
    const text = renderDoctorText({
      ...baseReport(),
      mcpConfigDrift: {
        scanned: 1,
        drifted: [],
        launcherOk: true,
        launchers: [],
        note: "scanned ~/Gits/*/.mcp.json for cmuxlayer launcher drift",
      },
    });
    expect(text).toMatch(/no .*mcp.*drift/i);
  });

  it("prints drifted .mcp.json paths without changing the healthy header", () => {
    const text = renderDoctorText({
      ...baseReport(),
      healthy: true,
      mcpConfigDrift: {
        scanned: 2,
        drifted: [
          {
            path: "/Users/etanheyman/Gits/drift/.mcp.json",
            serverKey: "cmuxlayer",
            reason: "does not reference launcher cmuxlayer-mcp",
          },
        ],
        launcherOk: true,
        launchers: [],
        note: "scanned ~/Gits/*/.mcp.json for cmuxlayer launcher drift",
      },
    });

    expect(text).toMatch(/doctor .* healthy/i);
    expect(text).toMatch(/1 drifted/i);
    expect(text).toMatch(/\/Users\/etanheyman\/Gits\/drift\/\.mcp\.json/);
    expect(text).toMatch(/cmuxlayer/);
  });
});

describe("renderDoctorJson", () => {
  it("emits parseable JSON with the report fields", () => {
    const report: DoctorReport = {
      healthy: true,
      version: { ok: true, value: "0.3.0" },
      caskSelfHeal: {
        applicable: false,
        note: "not-applicable: stdio MCP, no cask",
      },
      daemon: {
        applicable: true,
        ok: true,
        listening: false,
        note: "no daemon running (starts on demand)",
      },
      selfHeal: {
        available: false,
        ok: true,
        panePtyDead: { count: 0, surfaces: [], truncated: false },
        monitorRegistry: {
          available: false,
          total: 0,
          rearming: 0,
          collapsed: 0,
          collapsedMonitors: [],
          truncated: false,
        },
        note: "no daemon running (starts on demand)",
      },
      tap: {
        brewAvailable: true,
        tapPresent: true,
        formulaResolves: true,
        note: "ok",
      },
      socketPath: { set: true, value: "/tmp/x.sock", note: "set" },
      cmuxCompatibility: {
        available: true,
        liveVersion: "0.64.17",
        severity: "info",
        tested: true,
        testedVersions: ["0.64.17", "0.64.14-nightly"],
        note: "running cmux v0.64.17; tested against v0.64.17, v0.64.14-nightly",
      },
      sleepGuard: {
        systemSleepPrevented: true,
        keepAliveLoaded: true,
        durable: true,
        note: "durable",
      },
      runtimeProvenance: {
        distEntrypoint: true,
        entrypoint:
          "/opt/homebrew/Cellar/cmuxlayer/0.3.1/libexec/dist/index.js",
        execPath: "/opt/homebrew/opt/node/bin/node",
        mode: "dist",
        nodeVersion: "v22.0.0",
        ok: true,
        note: "running dist/index.js",
      },
      mcpReconnectProcedure: {
        automation: false,
        note: "Manual probe: /mcp -> cmuxlayer -> Reconnect, then run cmuxlayer doctor --json.",
      },
      mcpConfigDrift: {
        scanned: 1,
        drifted: [
          {
            path: "/Users/etanheyman/Gits/drift/.mcp.json",
            serverKey: "cmuxlayer",
            reason: "does not reference launcher cmuxlayer-mcp",
          },
        ],
        launcherOk: true,
        launchers: [],
        note: "scanned ~/Gits/*/.mcp.json for cmuxlayer launcher drift",
      },
    };
    const json = renderDoctorJson(report);
    const parsed = JSON.parse(json) as DoctorReport;
    expect(parsed.healthy).toBe(true);
    expect(parsed.version.value).toBe("0.3.0");
    expect(parsed.caskSelfHeal.applicable).toBe(false);
    expect(parsed.daemon.applicable).toBe(true);
    expect(parsed.daemon.ok).toBe(true);
    expect(parsed.tap.tapPresent).toBe(true);
    expect(parsed.socketPath.set).toBe(true);
    expect(parsed.socketPath.value).toBe("/tmp/x.sock");
    expect(parsed.cmuxCompatibility.tested).toBe(true);
    expect(parsed.sleepGuard.durable).toBe(true);
    expect(parsed.runtimeProvenance.mode).toBe("dist");
    expect(parsed.mcpReconnectProcedure.automation).toBe(false);
    expect(parsed.mcpConfigDrift.scanned).toBe(1);
    expect(parsed.mcpConfigDrift.drifted[0]?.serverKey).toBe("cmuxlayer");
  });
});
