// Deterministic fake CLI behind the real SDK/MCP tool protocol. No model calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createServerContext, engineForTests } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { ExecFn } from "../src/cmux-client.js";
import { runWithCallerContext } from "../src/caller-context.js";
import { withFakeRightSplitTopology } from "./helpers/fake-right-split-topology.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const brief = "Read and follow /tmp/synthetic-brief.md";
type Payload = Record<string, unknown>;
type Boot = Payload & { agent_id: string; surface_id: string; contract_path: string;
  boot_prompt_receipt: { delivery_id: string; submit_dispatched: boolean } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(hidden = false, wrapped = false) {
  const root = mkdtempSync(join(tmpdir(), "spawn-contract-once-"));
  const pane = { draft: "", submitted: [] as string[], inputs: [] as string[],
    returns: 0, hidden, created: false, paste: "", initializing: 2, caller: LEAD, baselineRead: false, beforeReturn: undefined as (() => void) | undefined };
  const render = (text: string) => wrapped ? text.match(/.{1,96}/g)?.join("\n  ") ?? "" : text;
  const frame = () => ["OpenAI Codex (v0.157.0)",
    ...pane.submitted.map(text => `› ${render(text)}`),
    ...(pane.submitted.length ? ["Working (1s • esc to interrupt)"] : []),
    `› ${pane.hidden ? "" : render(pane.draft)}`,
    "  GPT-6.1-Sol high · ~/Gits/cmuxlayer", "  ? for shortcuts · 82% left"].join("\n");
  const response = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "" });
  const typeInput = (text: string) => {
    pane.inputs.push(text);
    // A paragraph boundary consumes the task, leaving the footer drafted.
    const parts = text.split(/\n\n/);
    if (parts.length > 1) pane.submitted.push(parts.shift()!);
    pane.draft += parts.join("\n\n");
  };
  const fake: ExecFn = async (_cmd, args) => {
    if (args.includes("read-screen")) {
      if (args.includes("surface:lead") || args.includes(LEAD)) return response({ surface: "surface:lead", text: "OpenAI Codex\nWorking (1s • esc to interrupt)\n›\n  GPT-6.1-Sol high · ~/Gits/cmuxlayer", lines: 20, scrollback_used: false });
      if (pane.beforeReturn) pane.baselineRead = true;
      const text = pane.initializing-- > 0 ? "OpenAI Codex\nInitializing…\nWorking (1s • esc to interrupt)\n›\n  GPT-6.1-Sol high · ~/Gits/cmuxlayer" : frame();
      return response({ surface: "surface:new", text, lines: 20, scrollback_used: false });
    }
    if (args.includes("send-key") && args.includes("return")) {
      pane.returns++;
      if (!pane.hidden && pane.draft) { pane.submitted.push(pane.draft); pane.draft = ""; }
      return response({});
    }
    if (args.includes("set-buffer")) { pane.paste = String(args.at(-1)); return response({}); }
    if (args.includes("paste-buffer")) { typeInput(pane.paste); pane.paste = ""; return response({}); }
    if (args.includes("send") && !args.includes("send-key")) {
      const text = String(args.at(-1));
      if (text.includes("cmuxlayer contract for") || !/(?:^|\s)brainlayer(?:Codex|Claude)(?:\s|$)/.test(text)) {
        typeInput(text);
      }
      return response({});
    }
    if (args.includes("list-windows")) return response({ windows: [{ ref: "window:1", workspace_count: 1 }] });
    if (args.includes("list-workspaces")) return response({ workspaces: [{ ref: "workspace:1", title: "Main", index: 0, selected: true }] });
    if (args.includes("list-panes")) {
      if (pane.baselineRead) pane.beforeReturn?.();
      return response({ workspace_ref: "workspace:1", window_ref: "window:1", panes: [{ ref: "pane:1", index: 0, focused: true, surface_count: pane.created ? 2 : 1, surface_refs: pane.created ? ["surface:lead", "surface:new"] : ["surface:lead"], surface_ids: pane.created ? [LEAD, CHILD] : [LEAD], selected_surface_ref: "surface:lead" }] });
    }
    if (args.includes("list-pane-surfaces")) return response({ workspace_ref: "workspace:1", pane_ref: "pane:1", surfaces: [
      { ref: "surface:lead", id: LEAD, title: "lead", type: "terminal", index: 0, selected: true },
      ...(pane.created ? [{ ref: "surface:new", id: CHILD, title: "agent-pane", type: "terminal", index: 1, selected: false }] : []),
    ] });
    if (args.includes("new-split") || args.includes("new-surface")) pane.created = true;
    return response({ workspace: "workspace:1", surface: "surface:new", surface_id: CHILD, pane: "pane:1", type: "terminal" });
  };
  const context = createServerContext(withTestSurfaceObserver({ exec: withFakeRightSplitTopology(fake), stateDir: root, inboxBaseDir: root,
    disableSpawnPreflight: true, safetyCallerContextProvider: () => ({ surfaceId: pane.caller, workspaceId: "workspace:1" }) }));
  const server = createServer({ context, inboxBaseDir: root });
  const engine = engineForTests(server);
  const lead = { agent_id: "lead-seat", surface_id: "surface:lead", surface_uuid: LEAD, workspace_id: "workspace:1",
    role: "orchestrator", cli: "codex", state: "working", repo: "brainlayer", model: "gpt-6.1-sol",
    version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as AgentRecord;
  engine.stateMgr.writeState(lead); engine.getRegistry().set(lead.agent_id, lead);
  const client = new Client({ name: "spawn-contract-ratchet", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(async () => { await client.close(); await server.close(); context.dispose(); rmSync(root, { recursive: true, force: true }); });
  const call = async (name: string, args: Payload): Promise<Payload> => {
    const result = await runWithCallerContext({ surfaceId: pane.caller, workspaceId: "workspace:1" },
      () => client.callTool({ name, arguments: args }));
    return result.structuredContent as Payload;
  };
  const spawn = async (args: Payload = {}) => {
    const boot = await call("spawn_agent", { verbose: true, repo: "brainlayer", cli: "codex", effort: "high",
      model: "gpt-6.1-sol", workspace: "workspace:1", prompt: brief, boot_prompt_timeout_ms: 800, ...args }) as Boot;
    expect(boot.ok, JSON.stringify(boot)).toBe(true);
    return boot;
  };
  const key = (surface: string) => call("send_to", { mode: "key", surface, text: "return", verbose: true });
  return { pane, context, engine, call, spawn, key };
}

describe("P0 one owned spawn contract submission", () => {
  it("initialization cannot consume the task while leaving a footer draft", async () => {
    const t = await setup();
    const boot = await t.spawn();
    expect(boot.boot_prompt_receipt, JSON.stringify(boot)).toMatchObject({ submit_dispatched: true, submit_verified: true });
    const expected = `${brief} ; cmuxlayer contract for ${boot.agent_id}: Read and follow ${boot.contract_path}`;
    expect(t.pane.inputs).toEqual([expected]);
    expect(t.pane.submitted).toEqual([expected]);
    expect(t.pane.draft).toBe("");
    expect(t.pane.returns).toBe(2); // launcher + one boot Return
    expect(boot.coordination_footer_delivered).toBe(true);
    expect(readFileSync(boot.contract_path, "utf8")).toContain("## Report");
  });

  it.each([false, true])("a delayed exact folded draft is owned once and waitable (wrapped=%s)", async wrapped => {
    const t = await setup(true, wrapped);
    const boot = await t.spawn();
    expect(boot.spawn_state).toBe("boot_unsubmitted");
    expect(boot.boot_prompt_receipt).toMatchObject({ typed: true, submit_dispatched: false });
    const waited = await t.call("wait_for", { delivery_id: boot.boot_prompt_receipt.delivery_id, timeout_ms: 1 });
    expect(waited.ok, JSON.stringify(waited)).toBe(true);
    expect(waited).toMatchObject({ typed: true, submit_dispatched: false, submit_verified: null });
    const text = t.pane.draft;
    t.pane.hidden = false;
    const sent = await t.key(boot.surface_id);
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, submit_verified: true });
    expect(t.pane.submitted).toEqual([text]);
    expect(t.pane.inputs).toEqual([text]);
    expect(t.pane.returns).toBe(2);
    expect(t.engine.stateMgr.readState(boot.agent_id)).toMatchObject({ boot_prompt_pending: false, prompt_delivered: true });
    const settled = await t.call("wait_for", { delivery_id: boot.boot_prompt_receipt.delivery_id, timeout_ms: 1 });
    expect(settled).toMatchObject({ submit_dispatched: true, submit_verified: true, terminal: true });
    expect(t.pane.returns).toBe(2);
  });

  it.each(["changed", "expired", "session", "surface", "caller", "last-read-edit"])("refuses %s ownership without Return", async fault => {
    const t = await setup(true);
    const boot = await t.spawn();
    t.pane.hidden = false;
    const before = t.pane.returns;
    const owner = [...t.context.typedDraftOwners.values()][0]!;
    expect(owner, JSON.stringify(boot)).toBeDefined();
    if (fault === "changed") t.pane.draft += " user edit";
    if (fault === "expired") owner.at = Date.now() - 300_001;
    if (fault === "caller") t.pane.caller = CHILD;
    if (fault === "session" || fault === "surface") {
      const updated = t.engine.stateMgr.updateRecord(boot.agent_id, fault === "session"
        ? { cli_session_id: "11111111-2222-4333-8444-555555555555", boot_instance_id: "new-boot" }
        : { surface_uuid: LEAD });
      t.engine.getRegistry().set(updated.agent_id, updated);
    }
    if (fault === "last-read-edit") t.pane.beforeReturn = () => { t.pane.draft += " user edit"; t.pane.beforeReturn = undefined; };
    const sent = await t.key(boot.surface_id);
    expect(sent.ok, JSON.stringify(sent)).toBe(false);
    expect(t.pane.returns).toBe(before);
    expect(t.pane.submitted).toEqual([]);
  });
});
