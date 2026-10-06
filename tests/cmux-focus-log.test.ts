import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSurfaceTopologyMutationInvalidation } from "../src/surface-topology.js";
import { CmuxClient } from "../src/cmux-client.js";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { CmuxSocketError } from "../src/cmux-socket-error.js";
import { enableDaemonLog, disableDaemonLog, flushDaemonLog } from "../src/daemon-log.js";

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmux-focus-log-"));
  logPath = join(dir, "daemon.log");
  enableDaemonLog({ path: logPath });
});
afterEach(async () => {
  await flushDaemonLog();
  disableDaemonLog();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function focusFromCaller(client: CmuxClient | CmuxSocketClient) {
  await client.selectWorkspace("workspace:1");
  await client.focusSurface("surface:2", { workspace: "workspace:1" });
}
async function lines() {
  await flushDaemonLog();
  return existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [];
}
function expectFocusLine(line: string, method: string, target: string) {
  expect(line).toContain(" focus_rpc ");
  expect(line).toContain(`method=${method}`);
  expect(line).toContain(`target=${target}`);
  expect(line).toMatch(/caller=tests\/cmux-focus-log\.test\.ts:\d+:\d+/);
  expect(line).not.toContain(dir);
  expect(line).not.toContain(process.cwd());
}

describe("focus RPC daemon diagnostics", () => {
  it.each([false, true])("CLI emits one safe caller line per issued focus operation, wrapped=%s", async (wrapped) => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const client = new CmuxClient({ exec, bin: "cmux-fixture", env: {} });
    await focusFromCaller(wrapped ? withSurfaceTopologyMutationInvalidation(client) : client);
    await client.listWorkspaces(); // Read traffic must not add focus diagnostics.
    const logged = await lines();
    expect(exec).toHaveBeenCalledTimes(3);
    expect(logged).toHaveLength(2);
    expectFocusLine(logged[0], "workspace.select", "workspace:1");
    expectFocusLine(logged[1], "surface.focus", "surface:2");
  });

  it.each([false, true])("socket logs each attempt once, including CLI fallback=%s", async (fallback) => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const client = new CmuxSocketClient({
      socketPath: join(dir, "never-opened.sock"),
      cliFallback: new CmuxClient({ exec, bin: "cmux-fixture", env: {} }),
    });
    const call = vi.spyOn((client as any).transport, "call").mockImplementation(async () => {
      if (fallback) throw new CmuxSocketError("fixture method missing", "method_not_found");
      return {};
    });
    try {
      await focusFromCaller(client);
      const logged = await lines();
      expect(call).toHaveBeenCalledTimes(2);
      expect(exec).toHaveBeenCalledTimes(fallback ? 2 : 0);
      expect(logged).toHaveLength(fallback ? 4 : 2);
      const selectLines = logged.filter(line => line.includes("method=workspace.select"));
      const focusLines = logged.filter(line => line.includes("method=surface.focus"));
      expect(selectLines).toHaveLength(fallback ? 2 : 1);
      expect(focusLines).toHaveLength(fallback ? 2 : 1);
      selectLines.forEach(line => expectFocusLine(line, "workspace.select", "workspace:1"));
      focusLines.forEach(line => expectFocusLine(line, "surface.focus", "surface:2"));
    } finally {
      client.disconnect();
    }
  });

  it("refused invalid surface targets produce no issued-RPC line", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const client = new CmuxClient({ exec, bin: "cmux-fixture", env: {} });
    await expect(client.focusSurface("2")).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
    await flushDaemonLog();
    expect(existsSync(logPath)).toBe(false);
  });
});
