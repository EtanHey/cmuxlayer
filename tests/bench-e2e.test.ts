import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import {
  assertNightlyIsolation,
  assertArtifactProvenance,
  assertCliFairnessTrace,
  buildBenchmarkRows,
  buildAbsentComparisonRow,
  buildRowsAndReserve,
  buildIsolatedRuntimeEnv,
  beginObservedTermination,
  cliArgs,
  cleanupDaemonResources,
  createScratchTargets,
  createOutputReservation,
  createSocketReservation,
  createWorkspaceReservation,
  daemonLogPath,
  FAIRNESS_CONTRACTS,
  appendFatalError,
  appendSettledFailures,
  assertOwnedDaemonHealthy,
  listPanesCliArgs,
  listPaneSurfacesCliArgs,
  listWindowsCliArgs,
  listWorkspacesCliArgs,
  markSurfaceTransportUntrusted,
  nearestRankPercentile,
  operationArgs,
  openExclusiveWriteStream,
  paneRefsFromListPanesStdout,
  payloadText,
  readGitHead,
  prepareBuiltEntries,
  prepareProvenanceThenReserveOutput,
  publishBenchmarkReceipt,
  retireStaleReclaimMarker,
  renderMarkdownTable,
  releaseReservations,
  resolveStableWorkspaceId,
  runCliReadScreen,
  installGracefulSignalAbort,
  assertNoUnexpectedDaemons,
  terminateUnexpectedDaemons,
  runCliListSurfaces,
  runBenchmarkRow,
  summarizeTransport,
  terminateChild,
  waitForSocket,
} from "../scripts/bench-e2e.mjs";

describe("bench-e2e measurement harness", () => {
  it("uses nearest-rank percentiles instead of copying p50 into p95", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);

    expect(nearestRankPercentile(samples, 50)).toBe(10);
    expect(nearestRankPercentile(samples, 95)).toBe(19);
  });

  it("builds adjacent MCP/CLI pairs for every required matrix row", () => {
    const rows = buildBenchmarkRows({
      concurrency: [1, 5, 10],
      payloadSizes: [250, 450, 520, 900],
      samplesPerWorker: 12,
    });

    expect(rows).toHaveLength(36);
    for (let index = 0; index < rows.length; index += 2) {
      expect(rows[index].client).toBe("mcp");
      expect(rows[index + 1].client).toBe("cli");
      expect(rows[index + 1]).toMatchObject({
        operation: rows[index].operation,
        concurrency: rows[index].concurrency,
        payload_chars: rows[index].payload_chars,
        samples_per_worker: 12,
      });
    }
    expect(rows.filter((row) => row.operation === "send_to")).toHaveLength(24);
    expect(rows.filter((row) => row.operation === "read_screen")).toHaveLength(
      6,
    );
    expect(
      rows.filter((row) => row.operation === "list_surfaces"),
    ).toHaveLength(6);
  });

  it("collects at least twelve samples from every concurrent worker", async () => {
    let clock = 0;
    const result = await runBenchmarkRow(
      {
        operation: "read_screen",
        client: "mcp",
        concurrency: 5,
        payload_chars: null,
        samples_per_worker: 12,
      },
      {
        nowMs: () => clock,
        runOperation: ({ worker, sample }) => {
          clock += worker + sample + 1;
          return {
            ok: true,
            transport: "socket",
            transport_fallbacks: [],
          };
        },
      },
    );

    expect(result.samples).toHaveLength(60);
    for (let worker = 0; worker < 5; worker += 1) {
      expect(
        result.samples.filter((sample) => sample.worker === worker),
      ).toHaveLength(12);
    }
    expect(result.sample_count).toBe(60);
    expect(result.p95_ms).toBeGreaterThan(result.p50_ms);
  });

  it("computes latency percentiles from successful operations only", async () => {
    let clock = 0;
    const result = await runBenchmarkRow(
      {
        operation: "send_to",
        client: "mcp",
        concurrency: 1,
        payload_chars: 520,
        samples_per_worker: 12,
      },
      {
        nowMs: () => clock,
        runOperation: ({ sample }) => {
          clock += sample < 6 ? 1 : 100;
          return {
            ok: sample >= 6,
            transport: "socket",
            transport_fallbacks: [],
          };
        },
      },
    );

    expect(result.error_count).toBe(6);
    expect(result.attempt_count).toBe(12);
    expect(result.success_count).toBe(6);
    expect(result.failure_rate_pct).toBe(50);
    expect(result.p50_ms).toBe(100);
    expect(result.p95_ms).toBe(100);
  });

  it("uses null percentiles when a row has no successful operations", async () => {
    let clock = 0;
    const result = await runBenchmarkRow(
      {
        operation: "send_to",
        client: "mcp",
        concurrency: 1,
        payload_chars: 900,
        samples_per_worker: 12,
      },
      {
        nowMs: () => clock,
        runOperation: () => {
          clock += 3;
          return {
            ok: false,
            transport: "cli",
            transport_fallbacks: ["paste_text"],
          };
        },
      },
    );

    expect(result.error_count).toBe(12);
    expect(result.attempt_count).toBe(12);
    expect(result.success_count).toBe(0);
    expect(result.failure_rate_pct).toBe(100);
    expect(result.p50_ms).toBeNull();
    expect(result.p95_ms).toBeNull();
  });

  it("stops a row after an in-flight operation receives the abort signal", async () => {
    const controller = new AbortController();
    let starts = 0;
    const pending = runBenchmarkRow(
      { concurrency: 1, samples_per_worker: 12 },
      {
        signal: controller.signal,
        runOperation: () => {
          starts += 1;
          return new Promise((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(controller.signal.reason),
              { once: true },
            );
          });
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("stop now"));
    await expect(pending).rejects.toThrow("stop now");
    expect(starts).toBe(1);
  });

  it("drains every worker before propagating an abort", async () => {
    const controller = new AbortController();
    let releaseFirst;
    let releaseSecond;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    const started = [];
    let settled = false;
    let rejection = null;
    const observed = runBenchmarkRow(
      { concurrency: 2, samples_per_worker: 1 },
      {
        signal: controller.signal,
        runOperation: async ({ worker }) => {
          started.push(worker);
          await (worker === 0 ? firstGate : secondGate);
          return { ok: true, transport: "socket", transport_fallbacks: [] };
        },
      },
    ).catch((error) => {
      settled = true;
      rejection = error;
    });

    expect(started).toEqual([0, 1]);
    controller.abort(new Error("stop all workers"));
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseSecond();
    await observed;
    expect(rejection).toMatchObject({ message: "stop all workers" });
  });

  it("counts transport and every fallback from the raw samples", () => {
    expect(
      summarizeTransport([
        { transport: "socket", transport_fallbacks: [] },
        { transport: "cli", transport_fallbacks: ["paste_text"] },
        { transport: "cli", transport_fallbacks: ["paste_text", "send"] },
      ]),
    ).toEqual({
      transport_counts: { socket: 1, cli: 2 },
      transport_fallback_counts: { paste_text: 2, send: 1 },
    });
  });

  it("renders attempts, successes, and failure rate beside percentiles", () => {
    const table = renderMarkdownTable([
      {
        operation: "send_to",
        concurrency_profile: "c5",
        payload_chars: 520,
        client: "mcp",
        attempt_count: 60,
        success_count: 47,
        failure_rate_pct: 21.67,
        p50_ms: 100,
        p95_ms: 200,
        transport_counts: { UNTRUSTED: 60 },
        transport_fallback_counts: { UNTRUSTED_D180: 60 },
      },
    ]);

    expect(table).toContain("| attempts | successes | failure % | p50 ms |");
    expect(table).toContain("| 60 | 47 | 21.67 | 100 | 200 |");
  });

  it("refuses production or ambiguous socket configuration", () => {
    expect(() =>
      assertNightlyIsolation({
        CMUX_SOCKET_PATH: "/tmp/cmux-production.sock",
        CMUXLAYER_DAEMON_SOCKET: "/tmp/cmuxlayer-nightly.sock",
      }),
    ).toThrow(/nightly/i);
    expect(() =>
      assertNightlyIsolation({
        CMUX_SOCKET_PATH: "/tmp/cmux-nightly.sock",
        CMUXLAYER_DAEMON_SOCKET: "/tmp/cmuxlayer-stated.sock",
      }),
    ).toThrow(/isolated daemon/i);
    expect(
      assertNightlyIsolation({
        CMUX_SOCKET_PATH: "/tmp/cmux-nightly.sock",
        CMUXLAYER_DAEMON_SOCKET: "/tmp/cmuxlayer-run10-nightly.sock",
      }),
    ).toEqual({
      cmuxSocketPath: "/tmp/cmux-nightly.sock",
      daemonSocketPath: "/tmp/cmuxlayer-run10-nightly.sock",
    });
  });

  it("creates one right-hand scratch surface per worker and tears down exact refs", async () => {
    const calls: string[][] = [];
    const outputs = [
      "OK surface:21 workspace:7\n",
      "OK surface:22 workspace:7\n",
      "OK surface:23 workspace:7\n",
    ];
    const fixture = await createScratchTargets(3, {
      workspace: "workspace:7",
      controllerSurface: "surface:20",
      execCmux: (args: string[]) => {
        calls.push(args);
        return { stdout: outputs.shift() ?? "OK\n", stderr: "" };
      },
    });

    expect(fixture.targets).toEqual(["surface:21", "surface:22", "surface:23"]);
    expect(calls.slice(0, 3)).toEqual([
      [
        "new-split",
        "right",
        "--workspace",
        "workspace:7",
        "--surface",
        "surface:20",
        "--focus",
        "false",
      ],
      [
        "new-split",
        "right",
        "--workspace",
        "workspace:7",
        "--surface",
        "surface:21",
        "--focus",
        "false",
      ],
      [
        "new-split",
        "right",
        "--workspace",
        "workspace:7",
        "--surface",
        "surface:22",
        "--focus",
        "false",
      ],
    ]);

    await fixture.close();
    expect(calls.slice(3)).toEqual([
      [
        "close-surface",
        "--workspace",
        "workspace:7",
        "--surface",
        "surface:23",
      ],
      [
        "close-surface",
        "--workspace",
        "workspace:7",
        "--surface",
        "surface:22",
      ],
      [
        "close-surface",
        "--workspace",
        "workspace:7",
        "--surface",
        "surface:21",
      ],
    ]);
  });

  it("uses an inert shell builtin payload of the exact requested size", () => {
    const payload = payloadText(520, 4, 11);

    expect(payload).toHaveLength(520);
    expect(payload.startsWith(": run10-e2e w4s11 ")).toBe(true);
  });

  it("keeps the legacy direct CLI send shape available but not comparable", () => {
    const args = cliArgs(
      { operation: "send_to", payload_chars: 520 },
      { workspace: "workspace:7", surface: "surface:21" },
      0,
      0,
    );

    expect(args.at(-1)).toHaveLength(521);
    expect(args.at(-1)?.endsWith("\n")).toBe(true);
  });

  it("walks the same all-window topology verbs as MCP list_surfaces", async () => {
    const config = { workspace: "workspace:7", surface: "surface:21" };

    expect(cliArgs({ operation: "list_surfaces" }, config, 0, 0)).toEqual([
      "--json",
      "--id-format",
      "both",
      "list-windows",
    ]);
    expect(listWindowsCliArgs()).toEqual([
      "--json",
      "--id-format",
      "both",
      "list-windows",
    ]);
    expect(listWorkspacesCliArgs("window:1")).toEqual([
      "--json",
      "--id-format",
      "both",
      "list-workspaces",
      "--window",
      "window:1",
    ]);
    expect(listPanesCliArgs("workspace:7")).toEqual([
      "--json",
      "--id-format",
      "both",
      "list-panes",
      "--workspace",
      "workspace:7",
    ]);
    expect(listPaneSurfacesCliArgs("workspace:7", "pane:3")).toEqual([
      "--json",
      "--id-format",
      "both",
      "list-pane-surfaces",
      "--workspace",
      "workspace:7",
      "--pane",
      "pane:3",
    ]);
    expect(
      paneRefsFromListPanesStdout(
        JSON.stringify({
          workspace_ref: "workspace:7",
          panes: [{ ref: "pane:1" }, { ref: "pane:2" }],
        }),
      ),
    ).toEqual(["pane:1", "pane:2"]);

    const calls: string[][] = [];
    const outputs = [
      { windows: [{ ref: "window:1", workspace_count: 1 }] },
      { workspaces: [{ ref: "workspace:7" }] },
      { workspace_ref: "workspace:7", panes: [{ ref: "pane:1" }] },
      { workspace_ref: "workspace:7", pane_ref: "pane:1", surfaces: [] },
    ];
    await runCliListSurfaces(
      { ...config, cmuxBin: "/opt/cmux", env: {} },
      (_command, args) => {
        calls.push(args);
        return { stdout: JSON.stringify(outputs.shift()), stderr: "" };
      },
    );
    expect(calls).toEqual([
      listWindowsCliArgs(),
      listWorkspacesCliArgs("window:1"),
      listPanesCliArgs("workspace:7"),
      listPaneSurfacesCliArgs("workspace:7", "pane:1"),
    ]);
  });

  it("defines and enforces one fairness contract for every operation", () => {
    expect(Object.keys(FAIRNESS_CONTRACTS)).toEqual([
      "send_to",
      "read_screen",
      "list_surfaces",
    ]);
    expect(FAIRNESS_CONTRACTS.send_to).toMatchObject({
      comparable: false,
      cli_work: null,
    });
    expect(FAIRNESS_CONTRACTS.send_to.reason).toMatch(
      /dynamic.*cannot be mirrored/i,
    );
    expect(() => assertCliFairnessTrace("send_to", [])).toThrow(
      /not comparable/,
    );
    for (const contract of [
      FAIRNESS_CONTRACTS.read_screen,
      FAIRNESS_CONTRACTS.list_surfaces,
    ]) {
      expect(contract.comparable).toBe(true);
      expect(contract.cli_work).toEqual(contract.mcp_work);
      expect(() =>
        assertCliFairnessTrace(contract.operation, contract.cli_work),
      ).not.toThrow();
      expect(() =>
        assertCliFairnessTrace(contract.operation, ["drifted-work"]),
      ).toThrow(/fairness contract drift/);
    }
  });

  it("emits an explicit absent row instead of an unfair send_to comparison", () => {
    const [mcpRow, cliRow] = buildBenchmarkRows({
      concurrency: [5],
      payloadSizes: [520],
      samplesPerWorker: 12,
      operations: ["send_to"],
      clients: ["mcp", "cli"],
    });

    expect(mcpRow.comparison_status).toBe("MEASURED");
    expect(cliRow).toMatchObject({
      client: "cli",
      comparison_status: "NOT_COMPARABLE",
    });
    expect(buildAbsentComparisonRow(cliRow)).toMatchObject({
      concurrency_profile: "c5",
      attempt_count: 0,
      success_count: 0,
      failure_rate_pct: null,
      p50_ms: null,
      p95_ms: null,
      comparison_status: "NOT_COMPARABLE",
    });
  });

  it("fans out multi-pane list_surfaces work concurrently like MCP", async () => {
    const calls: string[][] = [];
    const releases: Array<() => void> = [];
    const pending = runCliListSurfaces(
      {
        workspace: "workspace:7",
        surface: "surface:21",
        cmuxBin: "/opt/cmux",
        env: {},
      },
      (_command, args) => {
        calls.push(args);
        if (args.includes("list-windows")) {
          return {
            stdout: JSON.stringify({
              windows: [{ ref: "window:1", workspace_count: 1 }],
            }),
            stderr: "",
          };
        }
        if (args.includes("list-workspaces")) {
          return {
            stdout: JSON.stringify({ workspaces: [{ ref: "workspace:7" }] }),
            stderr: "",
          };
        }
        if (args.includes("list-panes")) {
          return {
            stdout: JSON.stringify({
              workspace_ref: "workspace:7",
              panes: [{ ref: "pane:1" }, { ref: "pane:2" }],
            }),
            stderr: "",
          };
        }
        return new Promise((resolve) => {
          releases.push(() =>
            resolve({
              stdout: JSON.stringify({ surfaces: [] }),
              stderr: "",
            }),
          );
        });
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      calls.filter((args) => args.includes("list-pane-surfaces")),
    ).toHaveLength(2);
    for (const release of releases) release();
    await pending;
  });

  it("adds the MCP topology workload to direct CLI read_screen samples", async () => {
    const calls: string[][] = [];
    const outputs = [
      "screen contents",
      JSON.stringify({
        windows: [{ ref: "window:1", workspace_count: 2 }],
      }),
      JSON.stringify({
        workspaces: [{ ref: "workspace:7" }, { ref: "workspace:8" }],
      }),
      JSON.stringify({
        workspace_ref: "workspace:7",
        panes: [{ ref: "pane:1" }],
      }),
      JSON.stringify({
        workspace_ref: "workspace:7",
        pane_ref: "pane:1",
        surfaces: [],
      }),
      JSON.stringify({
        workspace_ref: "workspace:8",
        panes: [{ ref: "pane:2" }],
      }),
      JSON.stringify({
        workspace_ref: "workspace:8",
        pane_ref: "pane:2",
        surfaces: [],
      }),
    ];

    await runCliReadScreen(
      {
        workspace: "workspace:7",
        surface: "surface:21",
        cmuxBin: "/opt/cmux",
        env: {},
      },
      0,
      0,
      (_command, args) => {
        calls.push(args);
        return { stdout: outputs.shift() ?? "", stderr: "" };
      },
    );

    expect(calls).toEqual([
      [
        "read-screen",
        "--surface",
        "surface:21",
        "--lines",
        "20",
      ],
      listWindowsCliArgs(),
      listWorkspacesCliArgs("window:1"),
      listPanesCliArgs("workspace:7"),
      listPaneSurfacesCliArgs("workspace:7", "pane:1"),
      listPanesCliArgs("workspace:8"),
      listPaneSurfacesCliArgs("workspace:8", "pane:2"),
    ]);
  });

  it("keeps direct CLI read_screen request identity equal to the raw-surface MCP request", () => {
    expect(
      cliArgs(
        { operation: "read_screen" },
        { workspace: "workspace:7", surface: "surface:21" },
        0,
        0,
      ),
    ).toEqual(["read-screen", "--surface", "surface:21", "--lines", "20"]);
  });

  it("treats read_screen topology churn as best effort like MCP", async () => {
    let call = 0;
    await expect(
      runCliReadScreen(
        {
          workspace: "workspace:7",
          surface: "surface:21",
          cmuxBin: "/opt/cmux",
          env: {},
        },
        0,
        0,
        () => {
          call += 1;
          if (call === 1) return { stdout: "screen contents", stderr: "" };
          throw new Error("workspace closed during topology collection");
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps read_screen successful when a topology pane or surface disappears", async () => {
    for (const failingVerb of ["list-panes", "list-pane-surfaces"]) {
      const outputs = [
        "screen contents",
        JSON.stringify({
          windows: [{ ref: "window:1", workspace_count: 1 }],
        }),
        JSON.stringify({ workspaces: [{ ref: "workspace:7" }] }),
        JSON.stringify({
          workspace_ref: "workspace:7",
          panes: [{ ref: "pane:1" }],
        }),
        JSON.stringify({ surfaces: [] }),
      ];
      await expect(
        runCliReadScreen(
          {
            workspace: "workspace:7",
            surface: "surface:21",
            cmuxBin: "/opt/cmux",
            env: {},
          },
          0,
          0,
          (_command, args) => {
            if (args.includes(failingVerb)) {
              throw new Error(`${failingVerb} raced with topology churn`);
            }
            return { stdout: outputs.shift() ?? "", stderr: "" };
          },
        ),
      ).resolves.toBeUndefined();
    }
  });

  it("retries an incomplete all-window CLI enumeration once", async () => {
    const calls: string[][] = [];
    const outputs = [
      { windows: [{ ref: "window:1", workspace_count: 2 }] },
      { workspaces: [{ ref: "workspace:7" }] },
      { windows: [{ ref: "window:1", workspace_count: 1 }] },
      { workspaces: [{ ref: "workspace:7" }] },
      { workspace_ref: "workspace:7", panes: [] },
    ];

    await runCliListSurfaces(
      {
        workspace: "workspace:7",
        surface: "surface:21",
        cmuxBin: "/opt/cmux",
        env: {},
      },
      (_command, args) => {
        calls.push(args);
        return { stdout: JSON.stringify(outputs.shift()), stderr: "" };
      },
    );

    expect(calls.filter((args) => args.at(-1) === "list-windows")).toHaveLength(
      2,
    );
  });

  it("does not mix an environment workspace UUID into raw-surface calls", () => {
    expect(
      operationArgs(
        {
          operation: "read_screen",
          payload_chars: null,
        },
        "surface:4",
        "43557C0A-1F0D-4947-98A6-440ACBC0BEF8",
        0,
        0,
      ),
    ).toEqual({ surface: "surface:4", lines: 20, parsed_only: true });
    expect(
      operationArgs(
        {
          operation: "list_surfaces",
          payload_chars: null,
        },
        "surface:4",
        "43557C0A-1F0D-4947-98A6-440ACBC0BEF8",
        0,
        0,
      ),
    ).toEqual({
      workspace: "43557C0A-1F0D-4947-98A6-440ACBC0BEF8",
      verbose: false,
    });
  });

  it("marks raw-surface send_to provenance UNTRUSTED under D180", () => {
    const row = markSurfaceTransportUntrusted({
      operation: "send_to",
      client: "mcp",
      payload_chars: 520,
      transport_counts: { socket: 2 },
      transport_fallback_counts: {},
      samples: [
        { transport: "socket", transport_fallbacks: [], ok: true },
        { transport: "socket", transport_fallbacks: [], ok: true },
      ],
    });

    expect(row.transport_counts).toEqual({ UNTRUSTED: 2 });
    expect(row.reported_transport_counts).toEqual({ socket: 2 });
    expect(row.inferred_transport).toBe("cli");
    expect(row.transport_note).toContain("D180");
    expect(row.samples[0]).toMatchObject({
      transport: "UNTRUSTED",
      reported_transport: "socket",
      inferred_transport: "cli",
      transport_trust: "untrusted",
    });
  });

  it("rejects an existing daemon log before startup can continue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const logPath = join(directory, "daemon.log");
    await writeFile(logPath, "existing\n", "utf8");
    try {
      await expect(openExclusiveWriteStream(logPath)).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("captures daemon log errors that occur after the stream opens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const logPath = join(directory, "daemon.log");
    let runtimeError = null;
    try {
      const stream = await openExclusiveWriteStream(logPath, (error) => {
        runtimeError = error;
      });
      const expected = new Error("disk full");
      stream.emit("error", expected);
      expect(runtimeError).toBe(expected);
      stream.end();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("observes a log-triggered termination rejection immediately", async () => {
    const expected = new Error("termination failed");
    const rejection = Promise.reject(expected);
    const originalCatch = rejection.catch.bind(rejection);
    let catchCalls = 0;
    rejection.catch = (...args) => {
      catchCalls += 1;
      return originalCatch(...args);
    };

    const observed = beginObservedTermination({}, () => rejection);

    expect(observed).toBe(rejection);
    expect(catchCalls).toBe(1);
    await expect(observed).rejects.toBe(expected);
  });

  it("keeps a benchmark receipt writable when git head lookup fails", async () => {
    await expect(
      readGitHead(() => {
        throw new Error("git unavailable");
      }),
    ).resolves.toBeNull();
    await expect(
      readGitHead(() => ({ stdout: "abc123\n", stderr: "" })),
    ).resolves.toBe("abc123");
  });

  it("reports both scratch creation and cleanup failures", async () => {
    let call = 0;
    await expect(
      createScratchTargets(2, {
        workspace: "workspace:7",
        controllerSurface: "surface:20",
        execCmux: () => {
          call += 1;
          if (call === 1) return { stdout: "OK surface:21\n", stderr: "" };
          if (call === 2) throw new Error("create failed");
          throw new Error("close failed");
        },
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "scratch target creation and teardown failed",
      errors: [
        expect.objectContaining({ message: "create failed" }),
        expect.objectContaining({
          message: expect.stringContaining("close failed"),
        }),
      ],
    });
  });

  it("stops scratch creation promptly after abort and still tears down", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    await expect(
      createScratchTargets(3, {
        workspace: "workspace:7",
        controllerSurface: "surface:20",
        signal: controller.signal,
        execCmux: (args: string[]) => {
          calls.push(args);
          controller.abort(new Error("stop creating"));
          return { stdout: "OK surface:21\n", stderr: "" };
        },
        closeCmux: (args: string[]) => {
          calls.push(args);
          return { stdout: "OK\n", stderr: "" };
        },
      }),
    ).rejects.toThrow(/stop creating/);
    expect(calls.filter((args) => args[0] === "new-split")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "close-surface")).toHaveLength(1);
  });

  it("escalates an unresponsive child from TERM to KILL", async () => {
    class FakeChild extends EventEmitter {
      exitCode = null;
      signalCode = null;
      signals: string[] = [];

      kill(signal: string) {
        this.signals.push(signal);
        if (signal === "SIGKILL") {
          this.signalCode = signal;
          queueMicrotask(() => {
            this.emit("exit", null, signal);
            this.emit("close", null, signal);
          });
        }
        return true;
      }
    }
    const child = new FakeChild();

    await terminateChild(child, 0);

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects when an unresponsive child survives the bounded KILL wait", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });

    await expect(terminateChild(child, 0)).rejects.toThrow(
      /did not exit after SIGKILL/,
    );
  });

  it("rejects when child signal delivery fails", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: () => false,
    });

    await expect(terminateChild(child, 0)).rejects.toThrow(
      /failed to deliver SIGTERM/,
    );
  });

  it("waits for stdio close after child exit", async () => {
    class ClosingChild extends EventEmitter {
      exitCode = null;
      signalCode = null;

      kill() {
        queueMicrotask(() => {
          this.exitCode = 0;
          this.emit("exit", 0, null);
        });
        return true;
      }
    }
    const child = new ClosingChild();
    let settled = false;
    const pending = terminateChild(child, 100).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    child.emit("close", 0, null);
    await pending;
  });

  it("releases the reservation even when child termination fails", async () => {
    const events: string[] = [];
    const child = {
      stdout: { unpipe: () => events.push("stdout-unpipe") },
      stderr: { unpipe: () => events.push("stderr-unpipe") },
    };
    const log = Object.assign(new EventEmitter(), {
      writableFinished: false,
      end() {
        events.push("log-end");
        this.writableFinished = true;
        queueMicrotask(() => this.emit("finish"));
      },
    });
    const reservation = {
      release() {
        events.push("release");
      },
    };

    await expect(
      cleanupDaemonResources({
        child,
        log,
        reservation,
        terminate: () => {
          throw new Error("terminate failed");
        },
      }),
    ).rejects.toMatchObject({ name: "AggregateError" });
    expect(events).toEqual([
      "stdout-unpipe",
      "stderr-unpipe",
      "log-end",
      "release",
    ]);
  });

  it("uses a unique daemon log beside the requested receipt", () => {
    expect(daemonLogPath("/tmp/bench.json", 42, 1234)).toBe(
      "/tmp/bench.json.daemon-42-1234.log",
    );
  });

  it("atomically excludes overlapping runs that share an output receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const first = await createOutputReservation(output);
    try {
      await expect(createOutputReservation(output)).rejects.toThrow(
        /output .* is already reserved/,
      );
    } finally {
      await first.release();
    }
    const afterRelease = await createOutputReservation(output);
    await afterRelease.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("uses one output lock through real and symbolic-link parent paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const realDirectory = join(directory, "real");
    const linkedDirectory = join(directory, "linked");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory, "dir");
    const first = await createOutputReservation(
      join(realDirectory, "receipt.json"),
    );
    try {
      await expect(
        createOutputReservation(join(linkedDirectory, "receipt.json")),
      ).rejects.toThrow(/already reserved/);
    } finally {
      await first.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers an output lock whose recorded owner is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const exitedChild = spawnSync(process.execPath, ["-e", ""]);
    expect(exitedChild.status).toBe(0);
    await writeFile(
      `${output}.lock`,
      `${JSON.stringify({ pid: exitedChild.pid, process_start: "exited-child" })}\n`,
      "utf8",
    );
    await utimes(`${output}.lock`, new Date(0), new Date(0));
    const reservation = await createOutputReservation(output);
    await reservation.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("recovers a reclaim marker whose recorded owner is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const exitedChild = spawnSync(process.execPath, ["-e", ""]);
    expect(exitedChild.status).toBe(0);
    await writeFile(
      `${output}.lock.reclaim`,
      `${JSON.stringify({ pid: exitedChild.pid, process_start: "exited-child" })}\n`,
      "utf8",
    );

    const reservation = await createOutputReservation(output);

    await reservation.release();
    await expect(stat(`${output}.lock.reclaim`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("atomically quarantines only the stale reclaim marker it inspected", async () => {
    const operations: string[] = [];
    const staleOwner = '{"pid":41,"claim_id":"stale"}\n';
    const replacementOwner = '{"pid":42,"claim_id":"live"}\n';

    const retired = await retireStaleReclaimMarker(
      "/tmp/output.lock.reclaim",
      staleOwner,
      {
        rename: (_source, destination) => {
          operations.push(`rename:${destination}`);
        },
        readFile: () => replacementOwner,
        link: (source, destination) => {
          operations.push(`restore:${source}:${destination}`);
          return Promise.resolve();
        },
        unlink: (path) => {
          operations.push(`unlink:${path}`);
          return Promise.resolve();
        },
        ownerIsLive: () => true,
        quarantinePath: "/tmp/output.lock.reclaim.retired-test",
      },
    );

    expect(retired).toBe(false);
    expect(operations).toEqual([
      "rename:/tmp/output.lock.reclaim.retired-test",
      "restore:/tmp/output.lock.reclaim.retired-test:/tmp/output.lock.reclaim",
      "unlink:/tmp/output.lock.reclaim.retired-test",
    ]);
    expect(operations).not.toContain("unlink:/tmp/output.lock.reclaim");
  });

  it("recovers a lock whose live PID belongs to a different process start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    await writeFile(
      `${output}.lock`,
      `${JSON.stringify({ pid: process.pid, process_start: "reused-pid-start" })}\n`,
      "utf8",
    );
    const reservation = await createOutputReservation(output);
    await reservation.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves a legacy numeric lock while its PID is live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    await writeFile(`${output}.lock`, `${process.pid}\n`, "utf8");
    await expect(createOutputReservation(output)).rejects.toThrow(
      /already reserved/,
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("allows only one winner when contenders reclaim the same stale lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    await writeFile(`${output}.lock`, "99999\n", "utf8");
    await utimes(`${output}.lock`, new Date(0), new Date(0));
    const contenders = await Promise.allSettled([
      createOutputReservation(output),
      createOutputReservation(output),
    ]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = contenders.find((result) => result.status === "fulfilled");
    await winner.value.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("serializes every run sharing one Nightly workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const first = await createWorkspaceReservation(
      "/tmp/cmux-nightly.sock",
      "workspace:7",
      directory,
    );
    try {
      await expect(
        createWorkspaceReservation(
          "/tmp/cmux-nightly.sock",
          "workspace:7",
          directory,
        ),
      ).rejects.toThrow(/already reserved/);
      await expect(
        createWorkspaceReservation(
          "/tmp/cmux-nightly.sock",
          "workspace:8",
          directory,
        ),
      ).rejects.toThrow(/already reserved/);
    } finally {
      await first.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes workspace refs and ids to one reservation key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const exec = (_command, args) => {
      if (args.includes("list-windows")) {
        return {
          stdout: JSON.stringify([
            { ref: "window:1", id: "WINDOW-UUID", workspace_count: 1 },
          ]),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          workspaces: [{ ref: "workspace:7", id: "WORKSPACE-UUID" }],
        }),
        stderr: "",
      };
    };
    const config = { cmuxBin: "/opt/cmux", env: {} };
    const byRef = await resolveStableWorkspaceId("workspace:7", config, exec);
    const byId = await resolveStableWorkspaceId("WORKSPACE-UUID", config, exec);
    expect(byRef).toBe("WORKSPACE-UUID");
    expect(byId).toBe("WORKSPACE-UUID");

    const first = await createWorkspaceReservation(
      "/tmp/cmux-nightly.sock",
      byRef,
      directory,
    );
    try {
      await expect(
        createWorkspaceReservation(
          "/tmp/cmux-nightly.sock",
          byId,
          directory,
        ),
      ).rejects.toThrow(/already reserved/);
    } finally {
      await first.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("turns TERM into an awaited graceful-abort signal", () => {
    const processLike = new EventEmitter();
    const controller = new AbortController();
    const remove = installGracefulSignalAbort(controller, processLike);

    processLike.emit("SIGTERM");
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason.message).toContain("SIGTERM");
    remove();
    expect(processLike.listenerCount("SIGTERM")).toBe(0);
    expect(processLike.listenerCount("SIGINT")).toBe(0);
  });

  it("moves daemon socket, monitor, watch, and state paths under the owned run directory", () => {
    const env = buildIsolatedRuntimeEnv(
      { PATH: "/usr/bin", HOME: "/opt/example-home" },
      {
        ownerDirectory: "/tmp/run10.sock.owner-abc",
        socketPath: "/tmp/run10.sock.owner-abc/daemon.sock",
      },
      "/tmp/cmux-nightly.sock",
    );

    expect(env).toMatchObject({
      CMUX_SOCKET_PATH: "/tmp/cmux-nightly.sock",
      CMUXLAYER_DAEMON_SOCKET: "/tmp/run10.sock.owner-abc/daemon.sock",
      HOME: "/tmp/run10.sock.owner-abc/home",
      CMUXLAYER_STATE_DIR: "/tmp/run10.sock.owner-abc/state",
    });
    expect(env.CMUXLAYER_SESSION_REGISTRY).toContain(
      "/tmp/run10.sock.owner-abc/",
    );
    expect(env.HOME).not.toBe("/opt/example-home");
    expect(env.CMUXLAYER_DAEMON_PID_RECEIPT).toContain(
      "/tmp/run10.sock.owner-abc/",
    );
    expect(env).not.toHaveProperty("CMUXLAYER_FORCE_INPROCESS");
    expect(env).not.toHaveProperty("CMUXLAYER_DEFAULT_PALETTE");
  });

  it("clears inherited MCP routing overrides from the isolated runtime", () => {
    const env = buildIsolatedRuntimeEnv(
      {
        PATH: "/usr/bin",
        CMUXLAYER_FORCE_INPROCESS: "1",
        CMUXLAYER_DEFAULT_PALETTE: "list_surfaces",
        CMUXLAYER_DAEMON_FD: "7",
        CMUXLAYER_HEAP_GUARD_BYTES: "1",
        CMUXLAYER_UNKNOWN_RUNTIME_TOGGLE: "enabled",
        NODE_OPTIONS: "--require /tmp/untrusted-node-hook.cjs",
        BUN_OPTIONS: "--preload /tmp/untrusted-bun-hook.ts",
        LISTEN_FDS: "1",
      },
      {
        ownerDirectory: "/tmp/run10.sock.owner-abc",
        socketPath: "/tmp/run10.sock.owner-abc/daemon.sock",
      },
      "/tmp/cmux-nightly.sock",
    );

    expect(env.CMUXLAYER_DAEMON_SOCKET).toContain("/tmp/run10.sock.owner-abc/");
    expect(env).not.toHaveProperty("CMUXLAYER_FORCE_INPROCESS");
    expect(env).not.toHaveProperty("CMUXLAYER_DEFAULT_PALETTE");
    expect(env).not.toHaveProperty("CMUXLAYER_DAEMON_FD");
    expect(env).not.toHaveProperty("CMUXLAYER_HEAP_GUARD_BYTES");
    expect(env).not.toHaveProperty("CMUXLAYER_UNKNOWN_RUNTIME_TOGGLE");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("BUN_OPTIONS");
    expect(env).not.toHaveProperty("LISTEN_FDS");
  });

  it("validates rows before reserving daemon resources", async () => {
    let reservationCalls = 0;

    await expect(
      buildRowsAndReserve(
        {
          concurrency: [1],
          payloadSizes: [520],
          samplesPerWorker: 1,
          operations: ["send_to"],
          clients: ["mcp"],
        },
        "/tmp/cmuxlayer-run10-nightly.sock",
        () => {
          reservationCalls += 1;
          throw new Error("must not reserve");
        },
      ),
    ).rejects.toThrow(/at least 12/);
    expect(reservationCalls).toBe(0);
  });

  it("builds default entries from a clean recorded revision", async () => {
    const calls: string[] = [];
    const result = await prepareBuiltEntries(
      {
        mcpEntry: "/repo/dist/index.js",
        daemonEntry: "/repo/dist/daemon.js",
      },
      {
        repoRoot: "/repo",
        exec: (_command, args) => {
          calls.push(args.join(" "));
          if (args[0] === "status") return { stdout: "", stderr: "" };
          if (args[0] === "rev-parse") {
            return { stdout: "abc123\n", stderr: "" };
          }
          return { stdout: "built\n", stderr: "" };
        },
        exists: () => true,
        hashFile: (path) => `sha256:${path}`,
        listRuntimeFiles: () => [
          "/repo/dist/daemon.js",
          "/repo/dist/index.js",
          "/repo/dist/server.js",
        ],
        resolveExecutable: () => "/opt/cmux/bin/cmux",
      },
    );

    expect(calls).toEqual([
      "status --porcelain",
      "rev-parse HEAD",
      "run build",
      "status --porcelain",
      "rev-parse HEAD",
    ]);
    expect(result).toEqual({
      git_head: "abc123",
      entries: {
        mcp: {
          path: "/repo/dist/index.js",
          sha256: "sha256:/repo/dist/index.js",
        },
        daemon: {
          path: "/repo/dist/daemon.js",
          sha256: "sha256:/repo/dist/daemon.js",
        },
      },
      runtime_root: "/repo/dist",
      runtime_files: [
        {
          path: "/repo/dist/daemon.js",
          sha256: "sha256:/repo/dist/daemon.js",
        },
        {
          path: "/repo/dist/index.js",
          sha256: "sha256:/repo/dist/index.js",
        },
        {
          path: "/repo/dist/server.js",
          sha256: "sha256:/repo/dist/server.js",
        },
      ],
      cli_executable: {
        requested: "cmux",
        path: "/opt/cmux/bin/cmux",
        sha256: "sha256:/opt/cmux/bin/cmux",
      },
    });
  });

  it("attests provenance before creating the output reservation", async () => {
    const events: string[] = [];
    const config = { out: "/repo/bench.json", cmuxBin: "cmux" };
    const provenance = {
      cli_executable: { path: "/opt/cmux/bin/cmux" },
    };

    const result = await prepareProvenanceThenReserveOutput(config, {
      prepare: () => {
        events.push("provenance");
        return provenance;
      },
      validate: () => {
        events.push("validate");
      },
      reserve: () => {
        events.push("reserve-output");
        return { release: () => undefined };
      },
    });

    expect(events).toEqual(["provenance", "validate", "reserve-output"]);
    expect(config.cmuxBin).toBe("/opt/cmux/bin/cmux");
    expect(result.artifactProvenance).toBe(provenance);
  });

  it("rejects mutable built entries whose hashes change after attestation", async () => {
    await expect(
      assertArtifactProvenance(
        {
          entries: {
            mcp: { path: "/repo/dist/index.js", sha256: "mcp-before" },
            daemon: { path: "/repo/dist/daemon.js", sha256: "daemon-before" },
          },
        },
        (path) =>
          path.endsWith("index.js") ? "mcp-after" : "daemon-before",
      ),
    ).rejects.toThrow(/artifact changed after attestation.*index\.js/);
  });

  it("rejects drift in an imported runtime sibling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const runtimeRoot = join(directory, "dist");
    const indexPath = join(runtimeRoot, "index.js");
    const serverPath = join(runtimeRoot, "server.js");
    await mkdir(runtimeRoot);
    await writeFile(indexPath, "index", "utf8");
    await writeFile(serverPath, "server", "utf8");
    let serverHash = "server-before";
    const provenance = {
      entries: {},
      runtime_root: runtimeRoot,
      runtime_files: [
        { path: indexPath, sha256: "index-before" },
        { path: serverPath, sha256: "server-before" },
      ],
    };
    const hashFile = (path) =>
      path === serverPath ? serverHash : "index-before";
    await expect(
      assertArtifactProvenance(provenance, hashFile),
    ).resolves.toBeUndefined();
    serverHash = "server-after";
    await expect(assertArtifactProvenance(provenance, hashFile)).rejects.toThrow(
      /artifact changed after attestation.*server\.js/,
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects built entry provenance when HEAD changes during the build", async () => {
    let headReads = 0;

    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
        },
        {
          repoRoot: "/repo",
          exec: (_command, args) => {
            if (args[0] === "status") return { stdout: "", stderr: "" };
            if (args[0] === "rev-parse") {
              headReads += 1;
              return {
                stdout: headReads === 1 ? "abc123\n" : "def456\n",
                stderr: "",
              };
            }
            return { stdout: "built\n", stderr: "" };
          },
          exists: () => true,
          hashFile: () => "unused",
          listRuntimeFiles: () => [],
          resolveExecutable: () => "/opt/cmux/bin/cmux",
        },
      ),
    ).rejects.toThrow(/revision changed during build/);
  });

  it("preserves primary, scratch, and daemon cleanup failures", () => {
    let fatal = appendFatalError(null, new Error("row failed"), "benchmark");
    fatal = appendFatalError(
      fatal,
      new Error("close failed"),
      "scratch teardown",
    );
    fatal = appendFatalError(fatal, new Error("stop failed"), "daemon stop");

    expect(fatal).toContain("benchmark: row failed");
    expect(fatal).toContain("scratch teardown: close failed");
    expect(fatal).toContain("daemon stop: stop failed");
  });

  it("preserves nested aggregate cleanup evidence in fatal_error", () => {
    const cleanup = new AggregateError(
      [new Error("SIGKILL failed"), new Error("reservation release failed")],
      "isolated daemon cleanup failed",
    );
    const stop = new AggregateError([cleanup], "isolated daemon stop failed");

    const fatal = appendFatalError(null, stop, "daemon stop");

    expect(fatal).toContain("isolated daemon stop failed");
    expect(fatal).toContain("isolated daemon cleanup failed");
    expect(fatal).toContain("SIGKILL failed");
    expect(fatal).toContain("reservation release failed");
  });

  it("fails health checks when the owned daemon exits after readiness", () => {
    const child = { exitCode: null, signalCode: null, pid: 4242 };
    expect(() => assertOwnedDaemonHealthy(child, null)).not.toThrow();
    child.exitCode = 17;
    expect(() => assertOwnedDaemonHealthy(child, null)).toThrow(
      /owned isolated daemon.*4242.*exitCode.*17/,
    );
  });

  it("detects and terminates any daemon autostarted by an MCP client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const receipt = join(directory, "daemon-pids.txt");
    await writeFile(receipt, "4242\n4343\n", "utf8");
    await expect(assertNoUnexpectedDaemons(receipt, 4242)).rejects.toThrow(
      /4343/,
    );
    let live = true;
    const signals = [];
    const signalPid = (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        if (!live) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return;
      }
      if (signal === "SIGTERM") live = false;
    };
    await terminateUnexpectedDaemons(receipt, 4242, "owner-token", {
      signalPid,
      pause: () => Promise.resolve(),
      verifyPid: () => Promise.resolve(true),
    });
    expect(signals).toContainEqual([4343, "SIGTERM"]);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to signal a recorded PID whose ownership token does not match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const receipt = join(directory, "daemon-pids.txt");
    await writeFile(receipt, "4343\n", "utf8");
    const signals = [];
    await expect(
      terminateUnexpectedDaemons(receipt, 4242, "owner-token", {
        signalPid: (_pid, signal) => signals.push(signal),
        verifyPid: () => Promise.resolve(false),
      }),
    ).rejects.toThrow(/unowned daemon cleanup failed/);
    expect(signals).toEqual([0]);
    await rm(directory, { recursive: true, force: true });
  });

  it("waits after SIGKILL before declaring an unexpected daemon alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const receipt = join(directory, "daemon-pids.txt");
    await writeFile(receipt, "4343\n", "utf8");
    let killProbes = 0;
    let killed = false;
    const signalPid = (_pid, signal) => {
      if (signal === "SIGKILL") killed = true;
      if (signal === 0 && killed) {
        killProbes += 1;
        if (killProbes >= 3) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
      }
    };
    await terminateUnexpectedDaemons(receipt, 4242, "owner-token", {
      signalPid,
      pause: () => Promise.resolve(),
      verifyPid: () => Promise.resolve(true),
    });
    expect(killProbes).toBe(4);
    await rm(directory, { recursive: true, force: true });
  });

  it("does not SIGKILL a PID that loses ownership after TERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const receipt = join(directory, "daemon-pids.txt");
    await writeFile(receipt, "4343\n", "utf8");
    const signals = [];
    let verifications = 0;
    await terminateUnexpectedDaemons(receipt, 4242, "owner-token", {
      signalPid: (_pid, signal) => signals.push(signal),
      pause: () => Promise.resolve(),
      verifyPid: () => Promise.resolve(++verifications === 1),
    });
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves every rejected MCP client shutdown", () => {
    const fatal = appendSettledFailures(
      null,
      [
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: new Error("client 1 failed") },
        { status: "rejected", reason: new Error("client 2 failed") },
      ],
      "MCP client stop",
    );

    expect(fatal).toContain("MCP client stop: client 1 failed");
    expect(fatal).toContain("MCP client stop: client 2 failed");
  });

  it("aggregates every top-level reservation release failure", async () => {
    const calls = [];
    await expect(
      releaseReservations([
        {
          release: () => {
            calls.push("output");
            throw new Error("output release failed");
          },
        },
        {
          release: () => {
            calls.push("workspace");
            throw new Error("workspace release failed");
          },
        },
      ]),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ message: "output release failed" }),
        expect.objectContaining({ message: "workspace release failed" }),
      ],
    });
    expect(calls).toEqual(["output", "workspace"]);
  });

  it("holds the output reservation until receipt publication finishes", async () => {
    const events = [];
    let finishWrite;
    const writeGate = new Promise((resolve) => {
      finishWrite = resolve;
    });
    const pending = publishBenchmarkReceipt(
      "/tmp/receipt.json",
      { schema_version: 1 },
      {
        release: () => {
          events.push("output-release");
        },
      },
      async () => {
        events.push("write-start");
        await writeGate;
        events.push("write-finish");
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["write-start"]);
    finishWrite();
    await pending;
    expect(events).toEqual(["write-start", "write-finish", "output-release"]);
  });

  it("cancels a pending socket retry without waiting for its deadline", async () => {
    const wait = waitForSocket(
      join(tmpdir(), `cmuxlayer-missing-${process.pid}-${Date.now()}.sock`),
      30_000,
    );
    const reason = new Error("startup failed elsewhere");

    wait.cancel(reason);

    await expect(wait.promise).rejects.toBe(reason);
  });

  it("reserves an owner-only directory for the isolated daemon socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const requestedPath = join(directory, "run10-nightly.sock");
    try {
      const reservation = await createSocketReservation(requestedPath);

      expect(reservation.socketPath).not.toBe(requestedPath);
      expect(reservation.socketPath.startsWith(`${requestedPath}.owner-`)).toBe(
        true,
      );
      expect(reservation.socketPath.endsWith("/daemon.sock")).toBe(true);

      await reservation.release();
      await expect(stat(reservation.ownerDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates a missing parent for a nested isolated socket request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const requestedPath = join(directory, "nested", "run10-nightly.sock");
    try {
      const reservation = await createSocketReservation(requestedPath);
      expect(reservation.socketPath).toContain(
        "/nested/run10-nightly.sock.owner-",
      );
      await reservation.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
