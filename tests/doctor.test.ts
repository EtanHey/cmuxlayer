import { describe, expect, it } from "vitest";
import {
  checkMcpConfigDrift,
  detectRuntimeProvenance,
  parseSystemSleepPrevented,
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
    ...opts,
  });
}

describe("runDoctor — report shape", () => {
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

  it("marks §5 daemon integrity as not-applicable (stdio MCP, no daemon)", async () => {
    const report = await runDoctorForTest({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.daemon.applicable).toBe(false);
    expect(report.daemon.note).toMatch(/not-applicable/i);
    expect(report.daemon.note).toMatch(/stdio MCP/i);
    expect(report.daemon.note).toMatch(/no daemon/i);
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
    const report = await checkMcpConfigDrift(
      fakeMcpConfigReaders({
        "/Users/etanheyman/Gits/clean/.mcp.json": mcpConfig({
          mcpServers: {
            cmuxlayer: {
              command: "/Users/etanheyman/.golems/bin/cmuxlayer-mcp",
              args: [],
            },
          },
        }),
      }),
    );

    expect(report.scanned).toBe(1);
    expect(report.drifted).toEqual([]);
    expect(report.note).toMatch(/launcher/i);
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
        applicable: false,
        note: "not-applicable: stdio MCP, no daemon (§5 daemon integrity)",
      },
      tap: {
        brewAvailable: true,
        tapPresent: true,
        formulaResolves: true,
        note: "tap CASKS need `brew trust etanhey/layers`; cmuxlayer is a formula, not gated",
      },
      socketPath: { set: false, value: null, note: "unset (auto-discover)" },
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

  it("prints the §5 not-applicable line explicitly", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/not-applicable: stdio MCP, no daemon/i);
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
        applicable: false,
        note: "not-applicable: stdio MCP, no daemon",
      },
      tap: {
        brewAvailable: true,
        tapPresent: true,
        formulaResolves: true,
        note: "ok",
      },
      socketPath: { set: true, value: "/tmp/x.sock", note: "set" },
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
        note: "scanned ~/Gits/*/.mcp.json for cmuxlayer launcher drift",
      },
    };
    const json = renderDoctorJson(report);
    const parsed = JSON.parse(json) as DoctorReport;
    expect(parsed.healthy).toBe(true);
    expect(parsed.version.value).toBe("0.3.0");
    expect(parsed.caskSelfHeal.applicable).toBe(false);
    expect(parsed.daemon.applicable).toBe(false);
    expect(parsed.tap.tapPresent).toBe(true);
    expect(parsed.socketPath.set).toBe(true);
    expect(parsed.socketPath.value).toBe("/tmp/x.sock");
    expect(parsed.sleepGuard.durable).toBe(true);
    expect(parsed.runtimeProvenance.mode).toBe("dist");
    expect(parsed.mcpReconnectProcedure.automation).toBe(false);
    expect(parsed.mcpConfigDrift.scanned).toBe(1);
    expect(parsed.mcpConfigDrift.drifted[0]?.serverKey).toBe("cmuxlayer");
  });
});
