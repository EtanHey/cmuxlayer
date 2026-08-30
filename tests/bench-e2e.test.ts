import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNightlyIsolation,
  buildBenchmarkRows,
  createScratchTargets,
  markSurfaceTransportUntrusted,
  nearestRankPercentile,
  operationArgs,
  openExclusiveWriteStream,
  payloadText,
  readGitHead,
  runBenchmarkRow,
  summarizeTransport,
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
    expect(rows.filter((row) => row.operation === "read_screen")).toHaveLength(6);
    expect(rows.filter((row) => row.operation === "list_surfaces")).toHaveLength(6);
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
        runOperation: async ({ worker, sample }) => {
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
      expect(result.samples.filter((sample) => sample.worker === worker)).toHaveLength(12);
    }
    expect(result.sample_count).toBe(60);
    expect(result.p95_ms).toBeGreaterThan(result.p50_ms);
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
      execCmux: async (args: string[]) => {
        calls.push(args);
        return { stdout: outputs.shift() ?? "OK\n", stderr: "" };
      },
    });

    expect(fixture.targets).toEqual(["surface:21", "surface:22", "surface:23"]);
    expect(calls.slice(0, 3)).toEqual([
      ["new-split", "right", "--workspace", "workspace:7", "--surface", "surface:20", "--focus", "false"],
      ["new-split", "right", "--workspace", "workspace:7", "--surface", "surface:21", "--focus", "false"],
      ["new-split", "right", "--workspace", "workspace:7", "--surface", "surface:22", "--focus", "false"],
    ]);

    await fixture.close();
    expect(calls.slice(3)).toEqual([
      ["close-surface", "--workspace", "workspace:7", "--surface", "surface:23"],
      ["close-surface", "--workspace", "workspace:7", "--surface", "surface:22"],
      ["close-surface", "--workspace", "workspace:7", "--surface", "surface:21"],
    ]);
  });

  it("uses an inert shell builtin payload of the exact requested size", () => {
    const payload = payloadText(520, 4, 11);

    expect(payload).toHaveLength(520);
    expect(payload.startsWith(": run10-e2e w4s11 ")).toBe(true);
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
    ).toEqual({ workspace: "43557C0A-1F0D-4947-98A6-440ACBC0BEF8", verbose: false });
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

  it("keeps a benchmark receipt writable when git head lookup fails", async () => {
    await expect(
      readGitHead(async () => {
        throw new Error("git unavailable");
      }),
    ).resolves.toBeNull();
    await expect(
      readGitHead(async () => ({ stdout: "abc123\n", stderr: "" })),
    ).resolves.toBe("abc123");
  });

});
