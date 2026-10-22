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

  it("walks through node and the Codex app-server without an environment signal", () => {
    const lookup: ProcessLookup = (pid) => new Map([
      [40, { ppid: 30, command: "node cmuxlayer-wrapper.js" }],
      [30, { ppid: 20, command: "codex app-server" }],
      [20, { ppid: 1, command: t3 }],
    ]).get(pid);
    expect(findT3CodeAncestor(40, lookup)).toEqual({ pid: 20, command: t3 });
  });

  it.each(["/sbin/launchd", "/Applications/cmux.app/Contents/MacOS/cmux", "/bin/zsh"])(
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
    ps.mockReset().mockReturnValueOnce(" 50 node codex app-server\n").mockReturnValueOnce(` 1 ${t3}\n`);
    const writeStderr = vi.fn();
    expect(refuseUnderT3Code({ parentPid: 42, writeStderr })).toBe(true);
    expect(ps.mock.calls.map((call) => call[1])).toEqual([
      ["-ww", "-o", "ppid=,command=", "-p", "42"],
      ["-ww", "-o", "ppid=,command=", "-p", "50"],
    ]);
    expect(writeStderr.mock.calls).toEqual([[`cmuxlayer: refusing to start under T3 Code (ancestor pid 50: ${t3})\n`]]);
  });

  it.each(["", "not a process", "1\n"])("fails open for unreadable ps output %j", (output) => {
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
