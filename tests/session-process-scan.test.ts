/**
 * #931 r2: the resume path's process-table scan must never block the event
 * loop: it runs `ps` through async execFile with a timeout, never
 * execFileSync, and an unreadable table is "no proof", not "no process".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(() => {
    throw new Error("execFileSync must not be used by the session scan");
  }),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { scanSessionProcesses } from "../src/util/pid-alive.js";

const SESSION = "019faccc-1111-7222-8333-444455556666";

describe("scanSessionProcesses (#926)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileSyncMock.mockClear();
  });

  it("reads the process table through async execFile with a timeout", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { timeout?: number }, cb: Function) => {
        expect(opts.timeout).toBeGreaterThan(0);
        cb(null, `  4242 codex resume ${SESSION}\n  77 /bin/zsh\n`, "");
      },
    );

    const pending = scanSessionProcesses(SESSION);
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toEqual([
      { pid: 4242, command: `codex resume ${SESSION}` },
    ]);
    expect(execFileMock).toHaveBeenCalledWith(
      "ps",
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns null (no proof) when ps fails or times out", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(Object.assign(new Error("timed out"), { killed: true }), "", "");
      },
    );

    await expect(scanSessionProcesses(SESSION)).resolves.toBeNull();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
