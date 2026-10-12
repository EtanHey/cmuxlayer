// Adapted from PR #1053's bounded initialization regression. No provider calls.
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createServerContext, engineForTests } from "../src/server.js";
import { composeBootDeliveryText, screenShowsCompletePendingInput } from "../src/delivery/composer-screen.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { ExecFn } from "../src/cmux-client.js";
import { runWithCallerContext } from "../src/caller-context.js";
import { withFakeRightSplitTopology } from "./helpers/fake-right-split-topology.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const brief = "Read and follow /tmp/synthetic-brief.md";
const pointer = "cmuxlayer contract for agent-1: Read and follow /tmp/contract.md";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(wrapped: boolean) {
  const root = mkdtempSync(join(tmpdir(), "codex-footer-hotfix-"));
  const pane = { draft: "", submitted: [] as string[], inputs: [] as string[],
    returns: 0, created: false, paste: "", initializing: 2 };
  const render = (text: string) => wrapped ? text.match(/.{1,96}/g)?.join("\n  ") ?? "" : text;
  const frame = () => ["OpenAI Codex (v0.162.1)",
    ...pane.submitted.map(text => `› ${render(text)}`),
    ...(pane.submitted.length ? ["Working (1s • esc to interrupt)"] : []),
    `› ${render(pane.draft)}`, "  GPT-6.1-Sol high · ~/Gits/cmuxlayer",
    "  ? for shortcuts · 82% left"].join("\n");
  const response = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "" });
  const typeInput = (text: string) => {
    pane.inputs.push(text);
    // Initialization consumes the task at a paragraph break, leaving a footer.
    const parts = text.split(/\n\n/);
    if (parts.length > 1) pane.submitted.push(parts.shift()!);
    pane.draft += parts.join("\n\n");
  };
  const fake: ExecFn = async (_cmd, args) => {
    if (args.includes("read-screen")) {
      if (args.includes("surface:lead") || args.includes(LEAD)) return response({ surface: "surface:lead", text: "OpenAI Codex\nWorking (1s • esc to interrupt)\n›\n  GPT-6.1-Sol high · ~/Gits/cmuxlayer", lines: 20, scrollback_used: false });
      const text = pane.initializing-- > 0 ? "OpenAI Codex\nInitializing…\nWorking (1s • esc to interrupt)\n›\n  GPT-6.1-Sol high · ~/Gits/cmuxlayer" : frame();
      return response({ surface: "surface:new", text, lines: 20, scrollback_used: false });
    }
    if (args.includes("send-key") && args.includes("return")) {
      pane.returns++;
      if (pane.draft) { pane.submitted.push(pane.draft); pane.draft = ""; }
      return response({});
    }
    if (args.includes("set-buffer")) { pane.paste = String(args.at(-1)); return response({}); }
    if (args.includes("paste-buffer")) { typeInput(pane.paste); pane.paste = ""; return response({}); }
    if (args.includes("send") && !args.includes("send-key")) {
      const text = String(args.at(-1));
      if (text.includes("cmuxlayer contract for")) typeInput(text);
      return response({});
    }
    if (args.includes("list-windows")) return response({ windows: [{ ref: "window:1", workspace_count: 1 }] });
    if (args.includes("list-workspaces")) return response({ workspaces: [{ ref: "workspace:1", title: "Main", index: 0, selected: true }] });
    if (args.includes("list-panes")) return response({ workspace_ref: "workspace:1", window_ref: "window:1", panes: [{ ref: "pane:1", index: 0, focused: true, surface_count: pane.created ? 2 : 1, surface_refs: pane.created ? ["surface:lead", "surface:new"] : ["surface:lead"], surface_ids: pane.created ? [LEAD, CHILD] : [LEAD], selected_surface_ref: "surface:lead" }] });
    if (args.includes("list-pane-surfaces")) return response({ workspace_ref: "workspace:1", pane_ref: "pane:1", surfaces: [
      { ref: "surface:lead", id: LEAD, title: "lead", type: "terminal", index: 0, selected: true },
      ...(pane.created ? [{ ref: "surface:new", id: CHILD, title: "agent-pane", type: "terminal", index: 1, selected: false }] : []),
    ] });
    if (args.includes("new-split") || args.includes("new-surface")) pane.created = true;
    return response({ workspace: "workspace:1", surface: "surface:new", surface_id: CHILD, pane: "pane:1", type: "terminal" });
  };
  const context = createServerContext(withTestSurfaceObserver({ exec: withFakeRightSplitTopology(fake), stateDir: root, inboxBaseDir: root,
    disableSpawnPreflight: true, safetyCallerContextProvider: () => ({ surfaceId: LEAD, workspaceId: "workspace:1" }) }));
  const server = createServer({ context, inboxBaseDir: root });
  const engine = engineForTests(server);
  const lead = { agent_id: "lead-seat", surface_id: "surface:lead", surface_uuid: LEAD, workspace_id: "workspace:1",
    role: "orchestrator", cli: "codex", state: "working", repo: "brainlayer", model: "gpt-6.1-sol",
    version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as AgentRecord;
  engine.stateMgr.writeState(lead); engine.getRegistry().set(lead.agent_id, lead);
  const client = new Client({ name: "codex-footer-hotfix", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(async () => { await client.close(); await server.close(); context.dispose(); engine.dispose(); rmSync(root, { recursive: true, force: true }); });
  const spawn = async () => runWithCallerContext({ surfaceId: LEAD, workspaceId: "workspace:1" },
    () => client.callTool({ name: "spawn_agent", arguments: { verbose: true, repo: "brainlayer", cli: "codex", effort: "high",
      model: "gpt-6.1-sol", workspace: "workspace:1", prompt: brief, boot_prompt_timeout_ms: 800 } }));
  return { pane, spawn };
}

describe("Codex boot footer composition hotfix", () => {
  it.each(["codex", "claude", "gemini"] as const)("keeps %s short pointers in one message", cli => {
    expect(composeBootDeliveryText(brief, pointer, cli)).toBe(`${brief} ; ${pointer}`);
  });

  it("preserves a contract-only or caller-only prompt", () => {
    expect(composeBootDeliveryText("", pointer, "codex")).toBe(pointer);
    expect(composeBootDeliveryText(brief, undefined, "codex")).toBe(brief);
  });

  it("preserves existing paragraph behavior outside the short-pointer condition", () => {
    expect(composeBootDeliveryText("one\n\ntwo", pointer, "codex")).toBe(`one\n\ntwo\n\n${pointer}`);
    expect(composeBootDeliveryText(brief, pointer, "cursor")).toBe(`${brief}\n\n${pointer}`);
  });

  it("does not treat a footer-only composer as the complete boot payload", () => {
    const screen = ["OpenAI Codex", `› ${brief}`, "Working (1s • esc to interrupt)",
      `› ${pointer}`, "  GPT-6.1-Sol high · ~/Gits/cmuxlayer", "  tab to queue message"].join("\n");
    expect(screenShowsCompletePendingInput(screen, `${brief} ; ${pointer}`)).toBe(false);
  });

  it.each([false, true])("initialization cannot consume the task and leave a footer (wrapped=%s)", async wrapped => {
    const t = await setup(wrapped);
    const result = await t.spawn();
    const boot = result.structuredContent as Record<string, any>;
    expect(boot.boot_prompt_receipt, JSON.stringify(boot)).toMatchObject({ submit_dispatched: true, submit_verified: true });
    const expected = `${brief} ; cmuxlayer contract for ${boot.agent_id}: Read and follow ${boot.contract_path}`;
    expect(t.pane.inputs).toEqual([expected]);
    expect(t.pane.submitted).toEqual([expected]);
    expect(t.pane.draft).toBe("");
    expect(t.pane.returns).toBe(2); // launcher + one complete boot Return
    expect(boot.coordination_footer_delivered).toBe(true);
  });
});
