import { describe, expect, it, vi } from "vitest";
import {
  PROCESS_TABLE_PS_ARGS,
  parseElapsedSeconds,
  parseCliOptions,
  parseLaunchdServicePids,
  parseProcessLine,
  runReaper,
  selectReapablePids,
  signalProcessBatch,
} from "../src/mcp-reaper.js";
import type { ProcessInfo } from "../src/mcp-reaper.js";

describe("selectReapablePids", () => {
  it("selects only ppid=1 idle node MCP server processes", () => {
    const processes: ProcessInfo[] = [
      {
        pid: 101,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etan/Gits/brainlayer-mcp/dist/index.js",
      },
      {
        pid: 102,
        ppid: 4242,
        etimes: 1200,
        command: "node /Users/etan/Gits/brainlayer-mcp/dist/index.js",
      },
      {
        pid: 103,
        ppid: 1,
        etimes: 120,
        command: "node /Users/etan/Gits/voicelayer-mcp/dist/index.js",
      },
      {
        pid: 104,
        ppid: 1,
        etimes: 1200,
        command: "python /Users/etan/Gits/brainlayer-mcp/server.py",
      },
      {
        pid: 105,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etan/Gits/some-mcp-adapter/dist/index.js",
      },
      {
        pid: 106,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etan/Gits/supervised-mcp/dist/index.js",
        launchdManaged: true,
      },
    ];

    expect(selectReapablePids(processes, { minAgeSeconds: 600 })).toEqual([
      101, 105,
    ]);
  });

  it("does not match bare mcp substrings outside the tight pattern and allowlist", () => {
    const processes: ProcessInfo[] = [
      {
        pid: 201,
        ppid: 1,
        etimes: 1200,
        command: "node /tmp/acme-mcp/dist/index.js",
      },
      {
        pid: 202,
        ppid: 1,
        etimes: 1200,
        command: "node /tmp/mcp/dist/index.js",
      },
      {
        pid: 203,
        ppid: 1,
        etimes: 1200,
        command: "node /tmp/mcproxy/dist/index.js",
      },
      {
        pid: 204,
        ppid: 1,
        etimes: 1200,
        command:
          "node /Users/etan/Gits/official/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
      },
      {
        pid: 205,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etan/Gits/acme-mcp/scripts/dev.js",
      },
    ];

    expect(selectReapablePids(processes, { minAgeSeconds: 600 })).toEqual([
      201, 204,
    ]);
  });

  it("honors custom known MCP server names without broadening to every mcp string", () => {
    const processes: ProcessInfo[] = [
      {
        pid: 301,
        ppid: 1,
        etimes: 1200,
        command: "node /srv/context7/dist/index.js",
      },
      {
        pid: 302,
        ppid: 1,
        etimes: 1200,
        command: "node /srv/mcp/dist/index.js",
      },
    ];

    expect(
      selectReapablePids(processes, {
        knownServerNames: ["context7"],
        minAgeSeconds: 600,
      }),
    ).toEqual([301]);
  });

  it("reaps orphaned cmuxlayer node MCP servers even though the path has no -mcp suffix", () => {
    const processes: ProcessInfo[] = [
      {
        // worktree dist form
        pid: 601,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etanheyman/Gits/cmuxlayer/dist/index.js",
      },
      {
        // brew Cellar form
        pid: 602,
        ppid: 1,
        etimes: 1200,
        command:
          "/opt/homebrew/opt/node/bin/node /opt/homebrew/Cellar/cmuxlayer/0.2.9/libexec/dist/index.js",
      },
      {
        // live: parent still alive -> not an orphan
        pid: 603,
        ppid: 4242,
        etimes: 1200,
        command: "node /Users/etanheyman/Gits/cmuxlayer/dist/index.js",
      },
      {
        // too young
        pid: 604,
        ppid: 1,
        etimes: 120,
        command: "node /Users/etanheyman/Gits/cmuxlayer/dist/index.js",
      },
      {
        // launchd-managed -> left alone
        pid: 605,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etanheyman/Gits/cmuxlayer/dist/index.js",
        launchdManaged: true,
      },
    ];

    expect(selectReapablePids(processes, { minAgeSeconds: 600 })).toEqual([
      601, 602,
    ]);
  });
});

describe("process table parsing", () => {
  it("parses macOS ps etime values into elapsed seconds", () => {
    expect(parseElapsedSeconds("00:01")).toBe(1);
    expect(parseElapsedSeconds("01:02:03")).toBe(3723);
    expect(parseElapsedSeconds("2-03:04:05")).toBe(183845);
  });

  it("parses pid, ppid, etime, and full argv from a ps row", () => {
    expect(
      parseProcessLine(
        "  4242     1 2-03:04:05 node /Users/etan/Gits/brainlayer-mcp/dist/index.js",
      ),
    ).toEqual({
      pid: 4242,
      ppid: 1,
      etimes: 183845,
      command: "node /Users/etan/Gits/brainlayer-mcp/dist/index.js",
    });
  });

  it("parses nonzero launchd service pids from launchctl print output", () => {
    expect(
      Array.from(
        parseLaunchdServicePids(
          [
            "services = {",
            "        852      -  com.mcplayer.bus",
            "      71776      0  com.whatsapp-mcp.bridge-business",
            "          0      0  com.golems.mcp-reaper",
            "}",
          ].join("\n"),
        ).entries(),
      ),
    ).toEqual([
      [852, "com.mcplayer.bus"],
      [71776, "com.whatsapp-mcp.bridge-business"],
    ]);
  });
});

describe("signalProcessBatch", () => {
  it("continues signaling remaining processes when one pid is already gone", () => {
    const signaled: Array<[number, NodeJS.Signals]> = [];
    const processes: ProcessInfo[] = [
      { pid: 401, ppid: 1, etimes: 1200, command: "node a-mcp/index.js" },
      { pid: 402, ppid: 1, etimes: 1200, command: "node b-mcp/index.js" },
      { pid: 403, ppid: 1, etimes: 1200, command: "node c-mcp/index.js" },
    ];

    const attempts = signalProcessBatch(processes, "SIGTERM", (pid, signal) => {
      if (pid === 402) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      signaled.push([pid, signal]);
    });

    expect(signaled).toEqual([
      [401, "SIGTERM"],
      [403, "SIGTERM"],
    ]);
    expect(attempts).toEqual([
      { ok: true, pid: 401, signal: "SIGTERM" },
      {
        errorCode: "ESRCH",
        errorMessage: "no such process",
        ok: false,
        pid: 402,
        signal: "SIGTERM",
      },
      { ok: true, pid: 403, signal: "SIGTERM" },
    ]);
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "marks %s failed when the pid remains alive after signaling",
    (signal) => {
      const processes: ProcessInfo[] = [
        { pid: 501, ppid: 1, etimes: 1200, command: "node live-mcp/index.js" },
      ];
      const signaled: Array<[number, NodeJS.Signals]> = [];

      const attempts = signalProcessBatch(
        processes,
        signal,
        (pid, attemptedSignal) => {
          signaled.push([pid, attemptedSignal]);
        },
        () => true,
      );

      expect(signaled).toEqual([[501, signal]]);
      expect(attempts).toEqual([
        {
          errorCode: "STILL_ALIVE",
          errorMessage: `pid 501 still alive after ${signal}`,
          ok: false,
          pid: 501,
          signal,
        },
      ]);
    },
  );
});

describe("parseCliOptions", () => {
  it("rejects numeric flags without values", () => {
    expect(() => parseCliOptions(["--min-age-seconds"])).toThrow(
      "--min-age-seconds requires a value",
    );
    expect(() => parseCliOptions(["--grace-seconds"])).toThrow(
      "--grace-seconds requires a value",
    );
  });
});

describe("runReaper audit evidence", () => {
  const reapable: ProcessInfo = {
    pid: 701,
    ppid: 1,
    etimes: 1200,
    command: "node /Users/etanheyman/Gits/cmuxlayer/dist/index.js",
  };

  const baseOptions = {
    dryRun: true,
    graceSeconds: 0,
    knownServerNames: [],
    logFile: "/tmp/cmuxlayer-reaper-test.log",
    minAgeSeconds: 600,
  };

  it("skips audit-log writes when nothing is reapable", async () => {
    const lines: string[] = [];
    const outputs: string[] = [];
    const readProcessTable = vi
      .fn<() => Promise<ProcessInfo[]>>()
      .mockResolvedValueOnce([]);

    await runReaper(baseOptions, {
      appendAuditLine: async (line) => {
        lines.push(line);
      },
      readProcessTable,
      readRamEvidence: () => ({
        processRssBytes: 11,
        systemFreeBytes: 22,
        systemTotalBytes: 33,
      }),
      writeStdout: (line) => {
        outputs.push(line);
      },
    });

    expect(readProcessTable).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
    expect(outputs).toEqual(["No reapable ppid=1 idle node MCP orphans found."]);
  });

  it("records before/after process and RAM evidence for dry-run audits", async () => {
    const lines: string[] = [];
    const outputs: string[] = [];
    const readProcessTable = vi
      .fn<() => Promise<ProcessInfo[]>>()
      .mockResolvedValueOnce([reapable])
      .mockResolvedValueOnce([reapable]);

    await runReaper(baseOptions, {
      appendAuditLine: async (line) => {
        lines.push(line);
      },
      readProcessTable,
      readRamEvidence: () => ({
        processRssBytes: 11,
        systemFreeBytes: 22,
        systemTotalBytes: 33,
      }),
      writeStdout: (line) => {
        outputs.push(line);
      },
    });

    expect(readProcessTable).toHaveBeenCalledTimes(2);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /AUDIT phase=before dry_run=true total_processes=1 reapable_processes=1 reapable_pids=701 system_free_bytes=22 system_total_bytes=33 process_rss_bytes=11/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /AUDIT phase=after dry_run=true total_processes=1 reapable_processes=1 reapable_pids=701 system_free_bytes=22 system_total_bytes=33 process_rss_bytes=11/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringContaining("DRY_RUN would terminate pid=701"),
    );
    expect(outputs).toContainEqual(
      expect.stringContaining("DRY_RUN would terminate pid=701"),
    );
  });

  it("records before/after evidence and signal attempts for execute audits", async () => {
    const lines: string[] = [];
    const outputs: string[] = [];
    const killCalls: Array<[number, NodeJS.Signals]> = [];
    const readProcessTable = vi
      .fn<() => Promise<ProcessInfo[]>>()
      .mockResolvedValueOnce([reapable])
      .mockResolvedValueOnce([]);

    await runReaper(
      { ...baseOptions, dryRun: false },
      {
        appendAuditLine: async (line) => {
          lines.push(line);
        },
        isProcessAlive: () => false,
        killProcess: (pid, signal) => {
          killCalls.push([pid, signal]);
        },
        readProcessTable,
        readRamEvidence: () => ({
          processRssBytes: 44,
          systemFreeBytes: 55,
          systemTotalBytes: 66,
        }),
        sleep: async () => {},
        writeStdout: (line) => {
          outputs.push(line);
        },
      },
    );

    expect(readProcessTable).toHaveBeenCalledTimes(2);
    expect(killCalls).toEqual([[701, "SIGTERM"]]);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /AUDIT phase=before dry_run=false total_processes=1 reapable_processes=1 reapable_pids=701 system_free_bytes=55 system_total_bytes=66 process_rss_bytes=44/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /AUDIT phase=after dry_run=false total_processes=0 reapable_processes=0 reapable_pids=- system_free_bytes=55 system_total_bytes=66 process_rss_bytes=44/,
      ),
    );
    expect(lines).toContainEqual(expect.stringContaining("SIGTERM pid=701"));
    expect(outputs).toContainEqual(expect.stringContaining("SIGTERM pid=701"));
  });
});

describe("PROCESS_TABLE_PS_ARGS", () => {
  it("requests unlimited ps output width before parsing argv", () => {
    expect(PROCESS_TABLE_PS_ARGS).toEqual([
      "-ww",
      "-axo",
      "pid=,ppid=,etime=,command=",
    ]);
  });
});
