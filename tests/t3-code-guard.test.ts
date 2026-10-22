import { describe, expect, it, vi } from "vitest";
import { findT3CodeAncestor, refuseUnderT3Code, type ProcessLookup } from "../src/t3-code-guard.js";

const ps = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: ps }));

const t3 = "/Applications/T3 Code.app/Contents/MacOS/T3 Code";

describe("T3 Code startup guard", () => {
  it("finds an immediate T3 parent", () => {
    expect(findT3CodeAncestor(42, () => ({ ppid: 1, command: t3 })))
      .toEqual({ pid: 42, command: t3 });
  });

  it.each([
    "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)",
    "/Applications/T3 Code.app/Contents/Frameworks/T3 Code Helper.app/Contents/MacOS/T3 Code Helper",
    "/Applications/T3 Code (Nightly).app/Contents/Frameworks/T3 Code (Nightly) Helper (Renderer).app/Contents/MacOS/T3 Code (Nightly) Helper (Renderer)",
    "/Applications/T3 Code (Nightly).app/Contents/Resources/resource-monitor/t3-resource-monitor",
  ])("recognizes the executable inside %s", (command) => {
    expect(findT3CodeAncestor(42, () => ({ ppid: 1, command }))).toEqual({ pid: 42, command });
  });

  it("walks through node and the Codex app-server without an environment signal", () => {
    const lookup: ProcessLookup = (pid) => new Map([
      [40, { ppid: 30, command: "node cmuxlayer-wrapper.js" }],
      [30, { ppid: 20, command: "codex app-server" }],
      [20, { ppid: 1, command: t3 }],
    ]).get(pid);
    expect(findT3CodeAncestor(40, lookup)).toEqual({ pid: 20, command: t3 });
  });

  it.each([
    "/sbin/launchd", "/Applications/cmux.app/Contents/MacOS/cmux", "/bin/zsh",
    'node wrapper.js --title "T3 Code"', "node ~/Gits/T3 Code-notes/wrap.js",
    "/Users/test/Gits/T3 Code-notes/wrap.js",
  ])(
    "allows %s ancestry", (command) => {
      expect(findT3CodeAncestor(42, () => ({ ppid: 1, command }))).toBeNull();
    },
  );

  it("fails open when lookup returns no process", () => {
    expect(findT3CodeAncestor(42, () => undefined)).toBeNull();
  });

  it("fails open when lookup throws", () => {
    expect(findT3CodeAncestor(42, () => { throw new Error("ps unavailable"); })).toBeNull();
  });

  it("terminates at pid 1", () => {
    const lookup = vi.fn(() => ({ ppid: 1, command: "/sbin/launchd" }));
    expect(findT3CodeAncestor(1, lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("terminates cycles", () => {
    const lookup = vi.fn((pid: number) => ({ ppid: pid === 42 ? 43 : 42, command: "node" }));
    expect(findT3CodeAncestor(42, lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("bounds the walk even if every lookup finds another parent", () => {
    const lookup = vi.fn((pid: number) => ({ ppid: pid + 1, command: "node" }));
    expect(findT3CodeAncestor(42, lookup, 3)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("writes exactly one stderr line when refusing", () => {
    const writeStderr = vi.fn();
    expect(refuseUnderT3Code({ parentPid: 42, lookup: () => ({ ppid: 1, command: t3 }), writeStderr })).toBe(true);
    expect(writeStderr.mock.calls).toEqual([[`cmuxlayer: refusing to start under T3 Code (ancestor pid 42: ${t3})\n`]]);
  });

  it("keeps allowed startup silent through the injectable lookup", () => {
    const writeStderr = vi.fn();
    expect(refuseUnderT3Code({ parentPid: 42, lookup: () => undefined, writeStderr })).toBe(false);
    expect(writeStderr).not.toHaveBeenCalled();
  });

  it("parses real ps output with spaces and follows its parent pid", () => {
    ps.mockReset().mockReturnValue(` 1 0 /sbin/launchd\n 42 50 /usr/bin/node\n 50 1 ${t3}\n`);
    const writeStderr = vi.fn();
    expect(refuseUnderT3Code({ parentPid: 42, writeStderr })).toBe(true);
    expect(ps.mock.calls.map((call) => call[1])).toEqual([
      ["-ww", "-Ao", "pid=,ppid=,comm="],
    ]);
    expect(writeStderr.mock.calls).toEqual([[`cmuxlayer: refusing to start under T3 Code (ancestor pid 50: ${t3})\n`]]);
  });

  it.each(["", "not a process", "1\n", `42 1 ${t3}\ninvalid row\n`,
    `42 1 ${t3}\n42 1 /usr/bin/node\n`, `9007199254740992 1 ${t3}\n`,
  ])("fails open for unreadable ps output %j", (output) => {
    ps.mockReset().mockReturnValue(output);
    expect(refuseUnderT3Code({ parentPid: 42, writeStderr: vi.fn() })).toBe(false);
  });

  it("fails open when the real ps command errors or times out", () => {
    ps.mockReset().mockImplementation(() => { throw new Error("ETIMEDOUT"); });
    expect(refuseUnderT3Code({ parentPid: 42, writeStderr: vi.fn() })).toBe(false);
  });

  it("keeps diagnostics on one line even for a multiline command", () => {
    const writeStderr = vi.fn();
    refuseUnderT3Code({ parentPid: 42, lookup: () => ({ ppid: 1, command: `${t3}\nargument` }), writeStderr });
    expect(writeStderr.mock.calls).toEqual([[`cmuxlayer: refusing to start under T3 Code (ancestor pid 42: ${t3} argument)\n`]]);
  });
});
