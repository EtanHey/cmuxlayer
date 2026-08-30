import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  assertNightlyIsolation,
  buildBenchmarkRows,
  cliArgs,
  createScratchTargets,
  createSocketReservation,
  daemonLogPath,
  markSurfaceTransportUntrusted,
  nearestRankPercentile,
  operationArgs,
  openExclusiveWriteStream,
  payloadText,
  readGitHead,
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
      execCmux: (args: string[]) => {
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

  it("submits direct CLI send rows with an actual newline", () => {
    const args = cliArgs(
      { operation: "send_to", payload_chars: 520 },
      { workspace: "workspace:7", surface: "surface:21" },
      0,
      0,
    );

    expect(args.at(-1)).toHaveLength(521);
    expect(args.at(-1)?.endsWith("\n")).toBe(true);
    expect(args.at(-1)?.endsWith("\\n")).toBe(false);
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
        expect.objectContaining({ message: expect.stringContaining("close failed") }),
      ],
    });
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
          queueMicrotask(() => this.emit("exit", null, signal));
        }
        return true;
      }
    }
    const child = new FakeChild();

    await terminateChild(child, 0);

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects when an unresponsive child survives the bounded KILL wait", async () => {
    class ImmortalChild extends EventEmitter {
      exitCode = null;
      signalCode = null;

      kill() {
        return true;
      }
    }

    await expect(terminateChild(new ImmortalChild(), 0)).rejects.toThrow(
      /did not exit after SIGKILL/,
    );
  });

  it("rejects when child signal delivery fails", async () => {
    class UnsignallableChild extends EventEmitter {
      exitCode = null;
      signalCode = null;

      kill() {
        return false;
      }
    }

    await expect(terminateChild(new UnsignallableChild(), 0)).rejects.toThrow(
      /failed to deliver SIGTERM/,
    );
  });

  it("uses a unique daemon log beside the requested receipt", () => {
    expect(daemonLogPath("/tmp/bench.json", 42, 1234)).toBe(
      "/tmp/bench.json.daemon-42-1234.log",
    );
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
      expect(
        reservation.socketPath.startsWith(`${requestedPath}.owner-`),
      ).toBe(true);
      expect(reservation.socketPath.endsWith("/daemon.sock")).toBe(true);

      await reservation.release();
      await expect(stat(reservation.ownerDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
