import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLIC_TOOL_NAMES } from "../src/mcp/schemas.js";

describe("registry-liveness live acceptance harness", () => {
  it("§b: self-tests dead-child receipt, screen-context, and convergence classification", () => {
    const script = resolve("scripts/acceptance-registry-liveness.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "--self-test-dead-child"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("delivered_false=PASS");
    expect(result.stdout).toContain("dead_error_skip=PASS");
    expect(result.stdout).toContain("live_agent_echo=PASS");
    expect(result.stdout).toContain("shell_false_green=PASS");
    expect(result.stdout).toContain("stale_identity_shell_false_green=PASS");
    expect(result.stdout).toContain("three_attempt_convergence=PASS");
    expect(result.stdout).toContain("scoped_broadcast_workspace=PASS");
    expect(result.stdout).toContain("unscoped_broadcast_refused=PASS");
    expect(result.stdout).toContain("interactive_wait_ready=PASS");
    expect(result.stdout).toContain("interactive_wait_timeout_loud=PASS");
    expect(result.stdout).toContain("unavailable_dead_child_is_skipped=PASS");
    expect(result.stdout).toContain("GREEN_DEADCHILD_SELFTEST");
  });

  it("refuses an unscoped role:all run before spawning the MCP server", () => {
    const script = resolve("scripts/acceptance-registry-liveness.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "--server", "/definitely/missing/cmuxlayer-server", "--count", "1"],
      {
        encoding: "utf8",
        env: { ...process.env, CMUX_LIVE_HARNESS: "1" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Refusing unscoped role:all broadcast");
    expect(result.stdout).not.toContain("MCP server exited");
  });

  it("reports a controlled RED result when the MCP server cannot spawn", () => {
    const script = resolve("scripts/acceptance-registry-liveness.mjs");
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--server",
        "/definitely/missing/cmuxlayer-server",
        "--count",
        "1",
        "--workspace",
        "workspace:test",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CMUX_LIVE_HARNESS: "1" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RED_REGISTRY_LIVENESS");
    expect(result.stderr).not.toContain("Unhandled 'error' event");
  });
});

// #889 must-fix 5: the script called get_agent_state, broadcast, and
// resync_agents, none of which the server lists any more.
describe("registry-liveness acceptance calls public tools only (#889)", () => {
  const script = resolve("scripts/acceptance-registry-liveness.mjs");

  it("calls no hidden tool, and every tool it calls is in its preflight list", async () => {
    const source = readFileSync(script, "utf8");
    const called = [...source.matchAll(/mcp\.call\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    for (const hidden of ["get_agent_state", "broadcast", "resync_agents"]) {
      expect(called).not.toContain(hidden);
    }
    const { REQUIRED_ACCEPTANCE_TOOLS } = await import("../scripts/acceptance-registry-liveness.mjs");
    const createWorkspaceOnly = ["create_workspace", "delete_workspace"];
    for (const name of called) {
      expect([...REQUIRED_ACCEPTANCE_TOOLS, ...createWorkspaceOnly]).toContain(name);
    }
    for (const name of REQUIRED_ACCEPTANCE_TOOLS) {
      expect(PUBLIC_TOOL_NAMES).toContain(name);
    }
  });

  it("maps list_agents({agent_ids, detail:full}) and send_to replies onto the old shapes", async () => {
    const { agentRowFromList, sendToReceipt } = await import("../scripts/acceptance-registry-liveness.mjs");
    expect(
      agentRowFromList(
        { agents: [{ agent_id: "a-1", state: { value: "ready" }, surface_id: "surface:4", detail: { workspace_id: "workspace:2" } }] },
        "a-1",
      ),
    ).toEqual({ agent_id: "a-1", state: "ready", surface_id: "surface:4", workspace_id: "workspace:2" });
    expect(() => agentRowFromList({ agents: [] }, "a-1")).toThrow(/did not return a-1/);
    expect(sendToReceipt("a-1", { ok: true, delivery_state: "submitted" }).delivered).toBe(true);
    expect(sendToReceipt("a-1", { ok: false, error: "dead" }).delivered).toBe(false);
    expect(sendToReceipt("a-1", { ok: true, delivered: false, skipped: "dead:error" })).toMatchObject({ delivered: false, skipped: "dead:error" });
  });

  it("exits RED in preflight naming a tool the server does not list, before any spawn", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmuxlayer-acceptance-preflight-"));
    const log = join(dir, "calls.log");
    const stub = join(dir, "stub-server.mjs");
    writeFileSync(
      stub,
      `import { appendFileSync } from "node:fs";
let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (typeof msg.id !== "number") continue;
    appendFileSync(${JSON.stringify(log)}, (msg.params?.name ?? msg.method) + "\\n");
    if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "stub", version: "0" } });
    else if (msg.method === "tools/list") reply(msg.id, { tools: ["spawn_agent", "list_agents", "read_screen", "close_surface"].map((name) => ({ name })) });
    else reply(msg.id, { structuredContent: { ok: false, error: "stub" } });
  }
});
`,
    );
    try {
      const result = spawnSync(
        process.execPath,
        [script, "--server", process.execPath, "--server-arg", stub, "--count", "1", "--workspace", "workspace:test"],
        { encoding: "utf8", env: { ...process.env, CMUX_LIVE_HARNESS: "1" }, timeout: 30_000 },
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("required tools missing from tools/list: send_to");
      expect(result.stdout).toContain("RED_REGISTRY_LIVENESS");
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      expect(calls).toContain("tools/list");
      expect(calls).not.toContain("spawn_agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
