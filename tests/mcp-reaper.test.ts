import { describe, expect, it } from "vitest";
import {
  parseElapsedSeconds,
  parseLaunchdServicePids,
  parseProcessLine,
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
      101,
      105,
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
      201,
      204,
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
});
