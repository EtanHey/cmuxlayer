import { describe, expect, it } from "vitest";
import {
  parseElapsedSeconds,
  parseProcessLine,
  selectReapablePids,
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
});
