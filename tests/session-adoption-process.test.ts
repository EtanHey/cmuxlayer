import { describe, it, expect, vi } from "vitest";
const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execFileMock }), execFileSync: execFileSyncMock }));
import { readAdoptionProcess } from "../src/session-adoption.js";

describe("adoption process identity", () => {
  it("reads Claude's command name when ucomm is its versioned executable", async () => {
    execFileSyncMock.mockReturnValue(new Date(Date.now() - 10_000).toString());
    execFileMock.mockImplementation(async (command, args) => {
      expect(["ps", "lsof"]).toContain(command);
      expect(args).toContain(String(process.pid));
      const output = command === "lsof" ? "n/synthetic/repo\n"
        : args.includes("comm=") ? "claude\n" : "2.1.296\n";
      return { stdout: output, stderr: "" };
    });
    expect(await readAdoptionProcess(process.pid)).toMatchObject({
      liveness: "alive", cli: "claude", cwd: "/synthetic/repo",
    });
  });
});
