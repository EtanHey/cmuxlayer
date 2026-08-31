import { describe, expect, it } from "vitest";
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import {
  advisoryLockInvocation,
  assertOutputOutsideGitMetadata,
  assertNightlyIsolation,
  assertArtifactProvenance,
  benchmarkGateFailures,
  assertLockPathIdentity,
  assertLockFileAuthority,
  assertCliFairnessTrace,
  buildBenchmarkRows,
  buildAbsentComparisonRow,
  buildRowsAndReserve,
  buildIsolatedRuntimeEnv,
  beginObservedTermination,
  canonicalOutputPath,
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
  provenanceStatusArgs,
  publishWithLockHolder,
  publishBenchmarkReceipt,
  renderPhase1BeforePublication,
  renderMarkdownTable,
  releaseReservations,
  resolveGitMetadataPaths,
  rollbackReservation,
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
  writeReceiptAtomically,
} from "../scripts/bench-e2e.mjs";

describe("bench-e2e measurement harness", () => {
  it("uses the native advisory-lock command on Darwin and Linux", () => {
    expect(advisoryLockInvocation("darwin", "/tmp/bench.lock")).toMatchObject({
      command: "/usr/bin/lockf",
      args: [
        "-s",
        "-k",
        "-t",
        "0",
        "/tmp/bench.lock",
        process.execPath,
        "-e",
        expect.stringContaining('process.stdout.write("LOCKED\\n")'),
      ],
      contendedStatus: 75,
    });
    expect(advisoryLockInvocation("linux", "/tmp/bench.lock")).toMatchObject({
      command: "/usr/bin/flock",
      args: [
        "-n",
        "/tmp/bench.lock",
        process.execPath,
        "-e",
        expect.stringContaining('process.stdout.write("LOCKED\\n")'),
      ],
      contendedStatus: 1,
    });
  });

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

  it("fails the benchmark gate on every MCP CLI fallback", () => {
    const directCliArm = {
      operation: "read_screen",
      client: "cli",
      concurrency_profile: "c1",
      error_count: 0,
      transport_counts: { cli: 12 },
      transport_fallback_counts: {},
    };
    const socketMcpArm = {
      operation: "send_to",
      client: "mcp",
      concurrency_profile: "c1",
      payload_chars: 450,
      error_count: 0,
      transport_counts: { UNTRUSTED: 12 },
      transport_fallback_counts: { UNTRUSTED_D180: 12 },
      reported_transport_counts: { socket: 12 },
      reported_transport_fallback_counts: {},
      inferred_transport: "socket",
      transport_trust: "untrusted",
    };

    expect(benchmarkGateFailures([directCliArm, socketMcpArm], null)).toEqual(
      [],
    );

    const failures = benchmarkGateFailures(
      [
        {
          ...socketMcpArm,
          concurrency_profile: "c5",
          payload_chars: 520,
          inferred_transport: "cli",
        },
        {
          ...socketMcpArm,
          operation: "read_screen",
          transport_counts: { cli: 1, socket: 11 },
        },
        {
          ...socketMcpArm,
          operation: "list_surfaces",
          transport_counts: { socket: 12 },
          reported_transport_fallback_counts: { cli_fallback_active: 1 },
        },
        {
          ...socketMcpArm,
          operation: "read_screen",
          transport_counts: { unknown: 12 },
          reported_transport_counts: {},
          inferred_transport: undefined,
        },
        {
          ...socketMcpArm,
          operation: "list_surfaces",
          transport_counts: {},
          reported_transport_counts: { socket: 12 },
          inferred_transport: "socket",
        },
      ],
      null,
    );

    expect(failures).toHaveLength(5);
    expect(failures.slice(0, 3).every((failure) =>
      failure.includes("cli fallback active"),
    )).toBe(true);
    expect(failures[0]).toContain("send_to mcp c5 payload=520");
    expect(failures[3]).toContain("unattested transport: transport_counts.unknown=12");
    expect(failures[4]).toContain("unattested transport: no attested transport");
  });

  it("renders the phase-1 BEFORE publication with tags, collapsed rows, and D201 evidence", () => {
    const d201 = {
      c1: {
        250: [0, 100],
        450: [0, 110],
        520: [0, 120],
        900: [0, 130],
      },
      c5: {
        250: [0, 700],
        450: [0, 710],
        520: [25, 819.45],
        900: [23.33, 1234.46],
      },
      c10: {
        250: [0, 1400],
        450: [0, 1500],
        520: [8.33, 1753.81],
        900: [6.67, 2198.73],
      },
    };
    const sendRows = Object.entries(d201).flatMap(([profile, payloads]) =>
      Object.entries(payloads).map(([payload, [failureRate, p50]]) => ({
        operation: "send_to",
        client: "mcp",
        concurrency_profile: profile,
        payload_chars: Number(payload),
        comparison_status: "MEASURED",
        sample_count: Number(profile.slice(1)) * 12,
        attempt_count: Number(profile.slice(1)) * 12,
        success_count:
          (Number(profile.slice(1)) * 12 * (100 - failureRate)) / 100,
        failure_rate_pct: failureRate,
        p50_ms: p50,
        p95_ms: p50 + 100,
        error_count: failureRate === 0 ? 0 : 1,
        transport_counts: { UNTRUSTED: Number(profile.slice(1)) * 12 },
        transport_fallback_counts: {
          UNTRUSTED_D180: Number(profile.slice(1)) * 12,
        },
        transport_trust: "untrusted",
        inferred_transport: Number(payload) > 500 ? "cli" : "socket",
      })),
    );
    const receipt = {
      git_head: "a".repeat(40),
      started_at: "2026-08-31T12:25:31.400Z",
      fatal_error: null,
      rows: [
        ...sendRows,
        {
          operation: "read_screen",
          client: "mcp",
          concurrency_profile: "c1",
          payload_chars: null,
          comparison_status: "MEASURED",
          sample_count: 12,
          attempt_count: 12,
          success_count: 12,
          failure_rate_pct: 0,
          p50_ms: 40,
          p95_ms: 50,
          error_count: 0,
          transport_counts: { socket: 12 },
          transport_fallback_counts: {},
        },
        {
          operation: "list_surfaces",
          client: "cli",
          concurrency_profile: "c10",
          payload_chars: null,
          comparison_status: "MEASURED",
          sample_count: 120,
          attempt_count: 120,
          success_count: 106,
          failure_rate_pct: 11.67,
          p50_ms: 655.48,
          p95_ms: 859.84,
          error_count: 14,
          transport_counts: { cli: 106, unknown: 14 },
          transport_fallback_counts: {},
        },
        {
          operation: "send_to",
          client: "cli",
          concurrency_profile: "c1",
          payload_chars: 250,
          comparison_status: "NOT_COMPARABLE",
          sample_count: 0,
          attempt_count: 0,
          success_count: 0,
          failure_rate_pct: null,
          p50_ms: null,
          p95_ms: null,
          error_count: 0,
          transport_counts: {},
          transport_fallback_counts: {},
        },
      ],
    };
    const markdown = renderPhase1BeforePublication(receipt);

    const summary = markdown.split("<details>")[0];
    expect(summary).toContain("7 rows unchanged");
    expect(summary).not.toContain("| read_screen | c1 | - | mcp |");
    expect(summary).toContain(
      "| send_to | c5 | 520 | mcp | sampled | FAIL | CLI_FALLBACK, OPERATION_ERROR |",
    );
    expect(summary).toContain(
      "| send_to | c1 | 250 | cli | single_shot | NOT_COMPARABLE | FAIRNESS_CONTRACT | — | — | — | — | — |",
    );
    expect(markdown).toContain("<summary>Full 15-row BEFORE table</summary>");
    expect(markdown).toContain("| read_screen | c1 | - | mcp | sampled | PASS |");

    const fatalMarkdown = renderPhase1BeforePublication({
      ...receipt,
      fatal_error: "workspace release failed after measurement",
    });
    expect(fatalMarkdown.split("<details>")[0]).toContain(
      "Fatal gate failure: workspace release failed after measurement",
    );
    expect(markdown).toContain("250/450 = 0% at c1, c5, and c10");
    expect(markdown).toContain("c1 = 0% at both 520 and 900 characters");
    expect(markdown).toContain(
      "c5 520/900 = 25%/23.33% at p50 819.45/1234.46 ms",
    );
    expect(markdown).toContain(
      "c10 520/900 = 8.33%/6.67% at p50 1753.81/2198.73 ms",
    );
    expect(markdown).toContain("evidence against simple capacity exhaustion");
    expect(markdown).toContain("does not identify the racing party");

    const predicateBreaks = [
      ["c5", 450, 1],
      ["c1", 900, 1],
      ["c10", 520, 30],
    ];
    for (const [profile, payload, failureRate] of predicateBreaks) {
      const inconclusive = renderPhase1BeforePublication({
        ...receipt,
        rows: receipt.rows.map((row) =>
          row.operation === "send_to" &&
          row.client === "mcp" &&
          row.concurrency_profile === profile &&
          row.payload_chars === payload
            ? { ...row, failure_rate_pct: failureRate }
            : row,
        ),
      });
      expect(inconclusive).toContain("D201: INCONCLUSIVE");
      expect(inconclusive).not.toContain(
        "evidence against simple capacity exhaustion",
      );
    }
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

  it("refuses a symbolic-link lock without modifying its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const target = join(directory, "do-not-touch.txt");
    await writeFile(target, "preserve me\n", "utf8");
    await symlink(target, `${output}.lock`);

    await expect(createOutputReservation(output)).rejects.toThrow();
    await expect(readFile(target, "utf8")).resolves.toBe("preserve me\n");
    await rm(directory, { recursive: true, force: true });
  });

  it("releases the kernel lock when the reserving process crashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const moduleUrl = new URL("../scripts/bench-e2e.mjs", import.meta.url).href;
    const crashed = spawn(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(moduleUrl)}).then(async ({ createOutputReservation }) => { await createOutputReservation(${JSON.stringify(output)}); process.stdout.write("RESERVED\\n"); process.stdin.resume(); });`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolveReady, reject) => {
        let stdout = "";
        let stderr = "";
        crashed.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          if (stdout.includes("RESERVED\n")) resolveReady();
        });
        crashed.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        crashed.once("error", reject);
        crashed.once("exit", (code, signal) => {
          reject(
            new Error(
              `reservation owner exited before readiness (${code ?? signal}): ${stderr}`,
            ),
          );
        });
      });
      crashed.kill("SIGKILL");
      await new Promise<void>((resolveClosed) => crashed.once("close", resolveClosed));

      let reservation;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          reservation = await createOutputReservation(output);
          break;
        } catch (error) {
          if (!String(error).includes("already reserved") || attempt === 49) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      expect(reservation).toBeDefined();
      await reservation.release();
    } finally {
      if (crashed.exitCode === null && crashed.signalCode === null) crashed.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports an unexpected lock-holder exit immediately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    let resolveHolderFailure;
    const holderFailurePromise = new Promise((resolveFailure) => {
      resolveHolderFailure = resolveFailure;
    });
    const reservation = await createOutputReservation(output, (error) => {
      resolveHolderFailure(error);
    });

    process.kill(reservation.lockHolderPid, "SIGKILL");
    const holderFailure = await Promise.race([
      holderFailurePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("lock holder exit was not reported")), 500),
      ),
    ]);

    expect(holderFailure).toBeInstanceOf(Error);
    expect(holderFailure.message).toMatch(/lock holder exited unexpectedly/);
    await expect(reservation.release()).rejects.toThrow(/exited before release/);
    await rm(directory, { recursive: true, force: true });
  });

  it("turns lock-holder stdin EPIPE into a controlled publication failure", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {
      queueMicrotask(() => {
        const error = new Error("broken pipe");
        error.code = "EPIPE";
        child.stdin.emit("error", error);
      });
      return true;
    };

    await expect(
      publishWithLockHolder(
        child,
        "/tmp/receipt.tmp",
        "/tmp/receipt.json",
        "benchmark output",
      ),
    ).rejects.toThrow(/command pipe failed/);
  });

  it("publishes the completed receipt from the process holding the kernel lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const temp = `${output}.tmp-test`;
    const reservation = await createOutputReservation(output);
    await writeFile(temp, "published\n", "utf8");

    await reservation.publishTemp(temp, output);

    await expect(readFile(output, "utf8")).resolves.toBe("published\n");
    await expect(stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    reservation.assertHealthy();
    await reservation.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses a non-regular output substituted after reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const temp = `${output}.tmp-test`;
    const reservation = await createOutputReservation(output);
    await writeFile(temp, "published\n", "utf8");
    expect(spawnSync("mkfifo", [output]).status).toBe(0);

    await expect(reservation.publishTemp(temp, output)).rejects.toThrow(
      /lock holder exited during publication/,
    );
    expect(spawnSync("test", ["-p", output]).status).toBe(0);
    await expect(readFile(temp, "utf8")).resolves.toBe("published\n");
    await expect(reservation.release()).rejects.toThrow(/exited before release/);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses publication after the reserved output directory is replaced", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-parent-"));
    const directory = join(parent, "results");
    const displaced = join(parent, "results-displaced");
    const output = join(directory, "receipt.json");
    const temp = `${output}.tmp-test`;
    await mkdir(directory);
    const reservation = await createOutputReservation(output);
    await rename(directory, displaced);
    await mkdir(directory);
    await writeFile(temp, "published\n", "utf8");

    await expect(reservation.publishTemp(temp, output)).rejects.toThrow(
      /lock path identity changed/,
    );
    await expect(readFile(temp, "utf8")).resolves.toBe("published\n");
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reservation.release()).rejects.toThrow(
      /lock path identity changed/,
    );
    await rm(parent, { recursive: true, force: true });
  });

  it("cleans abandoned receipt temps only after winning the output lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const first = await createOutputReservation(output);
    const temp = `${output}.tmp-1234-12345678-1234-1234-1234-123456789abc`;
    const unrelated = `${output}.tmp-before-edit`;
    await writeFile(temp, "partial\n", "utf8");
    await writeFile(unrelated, "user data\n", "utf8");

    await expect(createOutputReservation(output)).rejects.toThrow(
      /already reserved/,
    );
    await expect(readFile(temp, "utf8")).resolves.toBe("partial\n");

    await first.release();
    const next = await createOutputReservation(output);
    await expect(stat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("user data\n");
    await next.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("canonicalizes a symlinked output to its real target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const target = join(directory, "tracked.json");
    const output = join(directory, "receipt.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, output);

    await expect(canonicalOutputPath(output)).resolves.toBe(
      await realpath(target),
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects an existing output with another hard link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const target = join(directory, "tracked.json");
    const output = join(directory, "receipt.json");
    await writeFile(target, "{}\n", "utf8");
    await link(target, output);

    await expect(canonicalOutputPath(output)).rejects.toThrow(
      /multiple hard links/,
    );
    await expect(readFile(target, "utf8")).resolves.toBe("{}\n");
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects an existing non-regular output target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.fifo");
    expect(spawnSync("mkfifo", [output]).status).toBe(0);

    await expect(canonicalOutputPath(output)).rejects.toThrow(
      /non-regular output path/,
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects a hard-linked lock file without modifying its shared inode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const target = join(directory, "do-not-touch.txt");
    await writeFile(target, "preserve me\n", "utf8");
    await link(target, `${output}.lock`);

    await expect(createOutputReservation(output)).rejects.toThrow(
      /lock path has multiple hard links/,
    );
    await expect(readFile(target, "utf8")).resolves.toBe("preserve me\n");
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects a lock pathname that no longer names the opened inode", async () => {
    await expect(
      assertLockPathIdentity(
        "/repo/receipt.json.lock",
        { dev: 10, ino: 20 },
        () => ({ dev: 10, ino: 21, isFile: () => true, nlink: 1 }),
      ),
    ).rejects.toThrow(/lock path identity changed/);
  });

  it("rejects a lock inode owned by another user or writable by peers", () => {
    expect(() =>
      assertLockFileAuthority(
        "/tmp/cmuxlayer-bench-workspace.lock",
        { uid: 501, mode: 0o100600 },
        502,
      ),
    ).toThrow(/lock path has unsafe owner or permissions/);
    expect(() =>
      assertLockFileAuthority(
        "/tmp/cmuxlayer-bench-workspace.lock",
        { uid: 502, mode: 0o100666 },
        502,
      ),
    ).toThrow(/lock path has unsafe owner or permissions/);
  });

  it("detects lock pathname replacement throughout the reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    const reservation = await createOutputReservation(output);
    await rm(reservation.lockPath);
    await writeFile(reservation.lockPath, "replacement\n", { mode: 0o600 });

    expect(() => reservation.assertHealthy()).toThrow(/lock path identity changed/);

    await expect(reservation.release()).rejects.toThrow(
      /lock path identity changed/,
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("canonicalizes a dangling output symlink to its future target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const target = join(directory, "future.json");
    const output = join(directory, "receipt-link.json");
    await symlink(target, output);

    await expect(canonicalOutputPath(output)).resolves.toBe(
      join(await realpath(directory), "future.json"),
    );
    await rm(directory, { recursive: true, force: true });
  });

  it("canonicalizes beneath a missing parent without creating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "missing", "nested", "receipt.json");

    await expect(canonicalOutputPath(output)).resolves.toBe(
      join(await realpath(directory), "missing", "nested", "receipt.json"),
    );
    await expect(stat(join(directory, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("ignores an abandoned legacy reclaim marker", async () => {
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
    await expect(stat(`${output}.lock.reclaim`)).resolves.toBeDefined();
    await rm(directory, { recursive: true, force: true });
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

  it("does not treat legacy PID bytes as a live kernel lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const output = join(directory, "receipt.json");
    await writeFile(`${output}.lock`, `${process.pid}\n`, "utf8");
    const reservation = await createOutputReservation(output);
    await reservation.release();
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
          if (args.includes("status")) return { stdout: "", stderr: "" };
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
      "-C /repo status --porcelain --untracked-files=all",
      "rev-parse HEAD",
      "run build",
      "-C /repo status --porcelain --untracked-files=all",
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

  it("scrubs inherited runtime overrides from provenance builds", async () => {
    await prepareBuiltEntries(
      {
        mcpEntry: "/repo/dist/index.js",
        daemonEntry: "/repo/dist/daemon.js",
        env: {
          PATH: "/usr/bin",
          NODE_OPTIONS: "--require /tmp/untrusted-node-hook.cjs",
          NODE_PATH: "/tmp/untrusted-node-modules",
          BUN_OPTIONS: "--preload /tmp/untrusted-bun-hook.ts",
        },
      },
      {
        repoRoot: "/repo",
        exec: (_command, args, options) => {
          if (args[0] === "run") {
            expect(options.env).not.toHaveProperty("NODE_OPTIONS");
            expect(options.env).not.toHaveProperty("NODE_PATH");
            expect(options.env).not.toHaveProperty("BUN_OPTIONS");
          }
          if (args.includes("status")) return { stdout: "", stderr: "" };
          if (args[0] === "rev-parse") {
            return { stdout: "abc123\n", stderr: "" };
          }
          return { stdout: "built\n", stderr: "" };
        },
        exists: () => true,
        hashFile: (path) => `sha256:${path}`,
        listRuntimeFiles: () => [],
        resolveExecutable: () => "/opt/cmux/bin/cmux",
      },
    );
  });

  it("forces untracked provenance while excluding only the selected receipt artifacts", () => {
    const ownedTemp =
      "/repo/results/bench.json.tmp-1234-12345678-1234-1234-1234-123456789abc";
    const ownedLock = "/repo/results/bench.json.lock";
    const ownedLog = "/repo/results/bench.json.daemon-42-1234.log";
    expect(
      provenanceStatusArgs("/repo", "/repo/results/bench.json", [
        ownedLock,
        ownedLog,
        ownedTemp,
      ]),
    ).toEqual([
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude,literal)results/bench.json",
      ":(exclude,literal)results/bench.json.lock",
      ":(exclude,literal)results/bench.json.daemon-42-1234.log",
      ":(exclude,literal)results/bench.json.tmp-1234-12345678-1234-1234-1234-123456789abc",
    ]);
    expect(provenanceStatusArgs("/repo", "/tmp/bench.json")).toEqual([
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(
      provenanceStatusArgs("/repo", "/repo/results/bench.json", [
        "/repo/results/bench.json.lock-notes",
        "/repo/results/bench.json.daemon-notes.log",
      ]),
    ).not.toContainEqual(expect.stringContaining("lock-notes"));
  });

  it("rejects receipt output inside worktree or resolved Git metadata", async () => {
    await expect(
      assertOutputOutsideGitMetadata("/repo/.git/HEAD", "/repo", () => [
        "/repo/.git",
        "/external/repo.git/worktrees/bench",
        "/external/repo.git",
      ]),
    ).rejects.toThrow(/inside Git metadata/);
    await expect(
      assertOutputOutsideGitMetadata(
        "/external/repo.git/config",
        "/repo",
        () => [
          "/repo/.git",
          "/external/repo.git/worktrees/bench",
          "/external/repo.git",
        ],
      ),
    ).rejects.toThrow(/inside Git metadata/);
  });

  it("canonicalizes a symlinked gitdir marker before checking output containment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const realGit = join(directory, "real-git");
    const worktree = join(directory, "worktree");
    await mkdir(realGit);
    await mkdir(worktree);
    await symlink(realGit, join(worktree, "git-link"), "dir");
    await writeFile(join(worktree, ".git"), "gitdir: git-link\n", "utf8");

    expect(await resolveGitMetadataPaths(worktree)).toContain(
      await realpath(realGit),
    );

    await expect(
      assertOutputOutsideGitMetadata(join(realGit, "HEAD"), worktree),
    ).rejects.toThrow(/inside Git metadata/);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects receipt output inside nested checkout Git metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const nested = join(directory, "ignored", "nested-checkout");
    const nestedGit = join(nested, ".git");
    const output = join(nestedGit, "HEAD");
    await mkdir(nestedGit, { recursive: true });
    await writeFile(output, "ref: refs/heads/main\n", "utf8");

    await expect(
      assertOutputOutsideGitMetadata(output, directory),
    ).rejects.toThrow(/inside Git metadata/);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects receipt output inside a bare Git repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const bareGit = join(directory, "project.git");
    const output = join(bareGit, "HEAD");
    await mkdir(join(bareGit, "objects"), { recursive: true });
    await mkdir(join(bareGit, "refs"), { recursive: true });
    await writeFile(join(bareGit, "config"), "[core]\n\tbare = true\n", "utf8");
    await writeFile(output, "ref: refs/heads/main\n", "utf8");

    await expect(
      assertOutputOutsideGitMetadata(output, directory),
    ).rejects.toThrow(/inside Git metadata/);
    for (const bareSetting of ["bare = yes", "bare = on", "bare = 1", "bare"]) {
      await writeFile(
        join(bareGit, "config"),
        `[core]\n\t${bareSetting}\n`,
        "utf8",
      );
      await expect(
        assertOutputOutsideGitMetadata(output, directory),
      ).rejects.toThrow(/inside Git metadata/);
    }
    await writeFile(
      join(bareGit, "included.conf"),
      "[core]\n\tbare = yes\n",
      "utf8",
    );
    await writeFile(
      join(bareGit, "config"),
      "[include]\n\tpath = included.conf\n",
      "utf8",
    );
    await expect(
      assertOutputOutsideGitMetadata(output, directory),
    ).rejects.toThrow(/inside Git metadata/);
    await mkdir(join(bareGit, "refs", "heads"), { recursive: true });
    await writeFile(join(bareGit, "refs", "heads", "main"), "commit\n", "utf8");
    await rm(output);
    await symlink("refs/heads/main", output);
    await expect(
      assertOutputOutsideGitMetadata(output, directory),
    ).rejects.toThrow(/inside Git metadata/);
    await writeFile(join(bareGit, "config"), "[core]\n\tbare = false\n", "utf8");
    const linkedObjects = join(bareGit, "linked-objects");
    await rm(join(bareGit, "objects"), { recursive: true });
    await mkdir(linkedObjects);
    await symlink("linked-objects", join(bareGit, "objects"), "dir");
    await expect(
      assertOutputOutsideGitMetadata(output, directory),
    ).rejects.toThrow(/inside Git metadata/);
    await rm(join(bareGit, "config"));
    await expect(
      assertOutputOutsideGitMetadata(output, directory),
    ).rejects.toThrow(/inside Git metadata/);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects a receipt tracked by a nested checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmuxlayer-bench-e2e-"));
    const nested = join(directory, "nested-checkout");
    const output = join(nested, "receipt.json");
    await mkdir(join(nested, ".git"), { recursive: true });
    await writeFile(output, "tracked contents\n", "utf8");

    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: join(directory, "dist", "index.js"),
          daemonEntry: join(directory, "dist", "daemon.js"),
          out: output,
        },
        {
          repoRoot: directory,
          exec: async (_command, args) => {
            if (args[0] === "ls-files") return { stdout: "", stderr: "" };
            if (args[0] === "-C" && args[1] === (await realpath(nested))) {
              expect(args[2]).toBe("ls-files");
              return { stdout: "receipt.json\n", stderr: "" };
            }
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output receipt/);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects redirected Git metadata before provenance checks", async () => {
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/external/repository.git/HEAD",
          env: { ...process.env, GIT_DIR: "/external/repository.git" },
        },
        {
          repoRoot: "/repo",
          exec: () => {
            throw new Error("Git must not run with redirected metadata");
          },
        },
      ),
    ).rejects.toThrow(/redirected Git metadata/);

    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/receipt.json",
          env: { GIT_WORK_TREE: "/other-clean-checkout" },
        },
        {
          repoRoot: "/repo",
          exec: () => {
            throw new Error("Git must not inspect a redirected worktree");
          },
        },
      ),
    ).rejects.toThrow(/redirected Git metadata/);
  });

  it("scrubs inherited Git pathspec controls from provenance commands", async () => {
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/package.json",
          env: { GIT_LITERAL_PATHSPECS: "1" },
        },
        {
          repoRoot: "/repo",
          exec: (_command, args, options) => {
            if (args[0] === "ls-files") {
              return {
                stdout: options.env.GIT_LITERAL_PATHSPECS
                  ? ""
                  : "package.json\n",
                stderr: "",
              };
            }
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output receipt/);
  });

  it("scrubs ambient Git redirection when no environment is supplied", async () => {
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_WORK_TREE = "/other-clean-checkout";
    try {
      await expect(
        prepareBuiltEntries(
          {
            mcpEntry: "/repo/dist/index.js",
            daemonEntry: "/repo/dist/daemon.js",
            out: "/repo/package.json",
          },
          {
            repoRoot: "/repo",
            exec: (_command, args, options) => {
              if (args[0] === "ls-files") {
                expect(options.env.GIT_WORK_TREE).toBeUndefined();
                return { stdout: "package.json\n", stderr: "" };
              }
              throw new Error(`unexpected command: ${args.join(" ")}`);
            },
          },
        ),
      ).rejects.toThrow(/tracked output receipt/);
    } finally {
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
    }
  });

  it("scrubs command-scope Git configuration from provenance commands", async () => {
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/package.json",
          env: {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.worktree",
            GIT_CONFIG_VALUE_0: "/other-clean-checkout",
          },
        },
        {
          repoRoot: "/repo",
          exec: (_command, args, options) => {
            if (args.includes("ls-files")) {
              expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
              expect(options.env.GIT_CONFIG_KEY_0).toBeUndefined();
              expect(options.env.GIT_CONFIG_VALUE_0).toBeUndefined();
              return { stdout: "package.json\n", stderr: "" };
            }
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output receipt/);
  });

  it("refuses to exclude a tracked output receipt from provenance", async () => {
    let trackedPathspec;
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/:(literal)receipt.json",
        },
        {
          repoRoot: "/repo",
          exec: (_command, args) => {
            if (args[0] === "ls-files") {
              trackedPathspec = args.find((arg) =>
                arg.startsWith(":(literal)"),
              );
              return { stdout: ":(literal)receipt.json\n", stderr: "" };
            }
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output receipt/);
    expect(trackedPathspec).toBe(":(literal):(literal)receipt.json");
  });

  it("probes HEAD as well as the index for a staged-deleted receipt", async () => {
    let trackedProbeArgs = [];
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/results/bench.json",
        },
        {
          repoRoot: "/repo",
          exec: (_command, args) => {
            if (args[0] === "ls-files") {
              trackedProbeArgs = args;
              return { stdout: "results/bench.json\n", stderr: "" };
            }
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output receipt/);
    expect(trackedProbeArgs).toContain("--with-tree=HEAD");
  });

  it("rechecks that the output receipt remains untracked after the build", async () => {
    let trackedChecks = 0;
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/results/bench.json",
        },
        {
          repoRoot: "/repo",
          exec: (_command, args) => {
            if (args[0] === "ls-files") {
              trackedChecks += 1;
              return {
                stdout: trackedChecks === 1 ? "" : "results/bench.json\n",
                stderr: "",
              };
            }
            if (args.includes("status")) return { stdout: "", stderr: "" };
            if (args[0] === "rev-parse") {
              return { stdout: "abc123\n", stderr: "" };
            }
            if (args[0] === "run") return { stdout: "built\n", stderr: "" };
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output receipt/);
    expect(trackedChecks).toBe(2);
  });

  it("refuses to exclude a tracked receipt sidecar from provenance", async () => {
    let trackedProbeArgs = [];
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/results/bench.json",
        },
        {
          repoRoot: "/repo",
          listOwnedReceiptSidecars: () => [
            "/repo/results/bench.json.lock",
            "/repo/results/bench.json.daemon-42-1234.log",
          ],
          exec: (_command, args) => {
            if (args[0] === "ls-files") {
              trackedProbeArgs = args;
              const probesLock = args.includes(
                ":(literal)results/bench.json.lock",
              );
              return {
                stdout: probesLock ? "results/bench.json.lock\n" : "",
                stderr: "",
              };
            }
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output artifact.*bench\.json\.lock/);
    expect(trackedProbeArgs).toContain(
      ":(literal)results/bench.json.daemon-42-1234.log",
    );
    expect(trackedProbeArgs).not.toContainEqual(
      expect.stringContaining(".tmp-"),
    );
  });

  it("probes an enumerated owned temp literally without hiding malformed siblings", async () => {
    const ownedTemp =
      "/repo/results/bench.json.tmp-1234-12345678-1234-1234-1234-123456789abc";
    let trackedProbeArgs = [];
    await expect(
      prepareBuiltEntries(
        {
          mcpEntry: "/repo/dist/index.js",
          daemonEntry: "/repo/dist/daemon.js",
          out: "/repo/results/bench.json",
        },
        {
          repoRoot: "/repo",
          listOwnedReceiptTemps: () => [ownedTemp],
          exec: (_command, args) => {
            if (args[0] === "ls-files") {
              trackedProbeArgs = args;
              return {
                stdout: "results/bench.json.tmp-1234-12345678-1234-1234-1234-123456789abc\n",
                stderr: "",
              };
            }
            throw new Error(`unexpected command: ${args.join(" ")}`);
          },
        },
      ),
    ).rejects.toThrow(/tracked output artifact/);
    expect(trackedProbeArgs).toContain(
      ":(literal)results/bench.json.tmp-1234-12345678-1234-1234-1234-123456789abc",
    );
    expect(
      provenanceStatusArgs("/repo", "/repo/results/bench.json", [
        "/repo/results/bench.json.tmp-1-notes-12345678-1234-1234-1234-123456789abc",
      ]),
    ).not.toContainEqual(expect.stringContaining(".tmp-"));
  });

  it("attests provenance before creating the output reservation", async () => {
    const events: string[] = [];
    const config = { out: "/repo/bench.json", cmuxBin: "cmux" };
    const provenance = {
      cli_executable: { path: "/opt/cmux/bin/cmux" },
    };

    const result = await prepareProvenanceThenReserveOutput(config, {
      canonicalize: (path) => path,
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

  it("canonicalizes the output target before provenance validation", async () => {
    const config = { out: "/repo/receipt-link.json", cmuxBin: "cmux" };
    await expect(
      prepareProvenanceThenReserveOutput(config, {
        canonicalize: () => "/repo/package.json",
        prepare: (preparedConfig) => {
          throw new Error(`tracked output receipt: ${preparedConfig.out}`);
        },
      }),
    ).rejects.toThrow(/tracked output receipt: \/repo\/package\.json/);
    expect(config.out).toBe("/repo/package.json");
  });

  it("rejects a receipt output that aliases an attested artifact", async () => {
    const events: string[] = [];
    const artifactPath = "/repo/dist/index.js";

    await expect(
      prepareProvenanceThenReserveOutput(
        { out: artifactPath, cmuxBin: "cmux" },
        {
          canonicalize: (path) => path,
          prepare: () => ({
            entries: {
              mcp: { path: artifactPath, sha256: "mcp" },
            },
            runtime_files: [
              { path: artifactPath, sha256: "mcp" },
              { path: "/repo/dist/daemon.js", sha256: "daemon" },
            ],
            cli_executable: {
              path: "/opt/cmux/bin/cmux",
              sha256: "cli",
            },
          }),
          validate: () => events.push("validate"),
          reserve: () => {
            events.push("reserve");
            return { release: () => undefined };
          },
        },
      ),
    ).rejects.toThrow(/output receipt aliases attested artifact.*index\.js/);
    expect(events).toEqual(["validate"]);
  });

  it("rejects a receipt output anywhere inside the attested runtime root", async () => {
    const events: string[] = [];
    await expect(
      prepareProvenanceThenReserveOutput(
        { out: "/repo/dist/results/receipt.json", cmuxBin: "cmux" },
        {
          canonicalize: (path) => path,
          prepare: () => ({
            entries: {},
            runtime_root: "/repo/dist",
            runtime_files: [],
            cli_executable: { path: "/opt/cmux/bin/cmux", sha256: "cli" },
          }),
          validate: () => events.push("validate"),
          reserve: () => {
            events.push("reserve");
            return { release: () => undefined };
          },
        },
      ),
    ).rejects.toThrow(/output receipt is inside attested runtime root/);
    expect(events).toEqual(["validate"]);
  });

  it("rejects output recanonicalization after provenance and releases it", async () => {
    const events: string[] = [];
    await expect(
      prepareProvenanceThenReserveOutput(
        { out: "/repo/dist/link/HEAD", cmuxBin: "cmux" },
        {
          canonicalize: (path) => path,
          prepare: () => ({
            entries: {},
            cli_executable: { path: "/opt/cmux/bin/cmux", sha256: "cli" },
          }),
          validate: () => undefined,
          reserve: () => ({
            outputPath: "/repo/.git/HEAD",
            release: () => events.push("release"),
          }),
        },
      ),
    ).rejects.toThrow(/output path changed after provenance validation/);
    expect(events).toEqual(["release"]);
  });

  it("stops after preparation when reservation authority aborts", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await expect(
      prepareProvenanceThenReserveOutput(
        { out: "/repo/bench.json", cmuxBin: "cmux" },
        {
          signal: controller.signal,
          canonicalize: (path) => path,
          prepare: (preparedConfig) => {
            events.push(
              preparedConfig.signal === controller.signal
                ? "prepare"
                : "bad-signal",
            );
            controller.abort(
              new Error("workspace lock holder exited unexpectedly"),
            );
            return { cli_executable: { path: "/opt/cmux/bin/cmux" } };
          },
          validate: () => events.push("validate"),
          reserve: () => events.push("reserve"),
        },
      ),
    ).rejects.toThrow(/workspace lock holder exited unexpectedly/);
    expect(events).toEqual(["prepare"]);
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
            if (args.includes("status")) return { stdout: "", stderr: "" };
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

  it("preserves both a triggering failure and rollback failure", async () => {
    const primary = new Error("temp cleanup failed");
    const rollback = new Error("lock holder exited before release");

    await expect(
      rollbackReservation(
        primary,
        { release: () => Promise.reject(rollback) },
        "reservation rollback failed",
      ),
    ).rejects.toMatchObject({
      message: "reservation rollback failed",
      errors: [primary, rollback],
    });
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

  it("refuses publication after output reservation authority is lost", async () => {
    const events = [];
    await expect(
      publishBenchmarkReceipt(
        "/tmp/receipt.json",
        { rows: [] },
        {
          assertHealthy() {
            throw new Error("output lock holder exited unexpectedly");
          },
          release: () => events.push("release"),
        },
        () => events.push("write"),
      ),
    ).rejects.toThrow(/output lock holder exited unexpectedly/);
    expect(events).toEqual([]);
  });

  it("cancels an in-flight atomic receipt write when lock authority is lost", async () => {
    const controller = new AbortController();
    let rejectWrite;
    const pendingWrite = new Promise((_, reject) => {
      rejectWrite = reject;
    });
    const events = [];
    const publication = publishBenchmarkReceipt(
      "/tmp/receipt.json",
      { rows: [] },
      {
        assertHealthy() {
          return undefined;
        },
        release: () => events.push("release"),
      },
      async (_path, _contents, signal) => {
        events.push("write-start");
        signal.addEventListener(
          "abort",
          () => rejectWrite(signal.reason),
          { once: true },
        );
        await pendingWrite;
        events.push("write-finish");
      },
      controller.signal,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("output lock holder exited unexpectedly"));

    await expect(publication).rejects.toThrow(/lock holder exited unexpectedly/);
    expect(events).toEqual(["write-start"]);
  });

  it("does not publish an aborted atomic receipt temp file", async () => {
    const controller = new AbortController();
    const events = [];
    let rejectWrite;
    const pendingWrite = new Promise((_, reject) => {
      rejectWrite = reject;
    });
    const publication = writeReceiptAtomically(
      "/tmp/receipt.json",
      "{}\n",
      controller.signal,
      {
        async writeTemp(_path, _contents, options) {
          events.push(["write", options.flag, options.mode]);
          options.signal.addEventListener(
            "abort",
            () => rejectWrite(options.signal.reason),
            { once: true },
          );
          await pendingWrite;
        },
        publishTemp() {
          events.push(["publish"]);
        },
        removeTemp() {
          events.push(["cleanup"]);
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("lock authority lost"));

    await expect(publication).rejects.toThrow(/lock authority lost/);
    expect(events).toEqual([
      ["write", "wx", 0o600],
      ["cleanup"],
    ]);
  });

  it("syncs receipt data and parent metadata before completing publication", async () => {
    const events: string[] = [];
    await writeReceiptAtomically("/repo/results/receipt.json", "{}\n", null, {
      writeTemp: () => events.push("write"),
      syncTemp: () => events.push("sync-temp"),
      publishTemp: () => events.push("publish"),
      syncParent: (path) => events.push(`sync-parent:${path}`),
      removeTemp: () => events.push("cleanup"),
    });

    expect(events).toEqual([
      "write",
      "sync-temp",
      "publish",
      "sync-parent:/repo/results",
      "cleanup",
    ]);
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
