import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adoptManagedSession } from "../src/session-adoption.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { AgentEngine } from "../src/agent-engine.js";
import { registerSendToTool } from "../src/mcp/tools/send.js";
import type { AgentRecord } from "../src/agent-types.js";
const root = mkdtempSync(join(tmpdir(), "adoption-correction-"));
const surface = "046E9CEC-E253-4870-9BB8-942DCE7CC0EC", workspace = "19F83CA8-2598-4BB3-AC57-2D6C4460A22E";
const ts = Date.now();
const engines: AgentEngine[] = [];
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
async function fixture(name: string) {
  const dir = join(root, name); mkdirSync(dir, {recursive:true});
  const stateMgr = new StateManager(dir);
  const agent: AgentRecord = {
    agent_id: 'synthetic-lead', surface_id:'surface:unbound', surface_uuid:null, workspace_id:null,
    surface_observer_id:'current', surface_provenance:'cmuxlayer_spawn', state:'idle', repo:'synthetic',
    model:'preserved-model', effort:'high', cli:'codex', cli_session_id:'synthetic-session',
    task_summary:'synthetic', pid:null, version:0, created_at:new Date(ts-1000000).toISOString(),
    updated_at:new Date(ts-1000000).toISOString(), error:null, parent_agent_id:'synthetic-parent',
    spawn_depth:0, role:'orchestrator', authority:'lead', placement:'left', deletion_intent:false,
    quality:'unknown', max_cost_per_agent:null, user_killed:false, launch_cwd:'/synthetic/repo',
    boot_prompt_pending:true, prompt_delivered:false,
  };
  stateMgr.writeState(agent);
  const registry = new AgentRegistry(stateMgr,async()=>[],{observerId:'current'}); registry.set(agent.agent_id,agent);
  const historical = {...agent,surface_id:'surface:old',surface_uuid:'0F4C12C6-7185-4723-9FA5-19328AD81192',workspace_id:'workspace:old',surface_observer_id:'historical'};
  const witness = JSON.stringify({historical_tool_receipts:[{tool_result:[historical]}],exact_session_registrations:[]});
  const witnessPath=join(dir,'witness.json');writeFileSync(witnessPath,witness);
  const proof = {session_id:agent.cli_session_id!,surface_uuid:surface,cwd:agent.launch_cwd!,cli:'codex' as const,pid:4242,ts};
  const host = {registry,stateMgr,sessionProcessScanner:async()=>[],options:{
    currentRegistration:()=>proof,sessionHistory:()=>[],processProof:async()=>({liveness:'alive' as const,started_at:ts-100000,cwd:agent.launch_cwd!,cli:'codex'}),
  },observe:async()=>({topology:{complete:true,observerId:'current',observerEpoch:'current',surfaces:[{ref:'surface:new',id:surface,workspaceId:'workspace:current'}],titleBySurface:new Map(),workspaceBySurface:new Map([['surface:new','workspace:current']]),surfaceIdByRef:new Map([['surface:new',surface]]),surfaceRefById:new Map([[surface,'surface:new']])} as any,workspaces:[{ref:'workspace:current',id:workspace}] as any})};
  const request={surface,workspace,managed_agent_id:agent.agent_id,session_id:agent.cli_session_id!,expected_agent_version:0,observer_transition:{historical_owner_id:'historical',current_owner_id:'current'},binding_evidence_path:witnessPath,binding_evidence_sha256:createHash('sha256').update(witness).digest('hex')};
  return {host,request,stateMgr,agent,dir,registry};
}

describe("adoption corrective readback", () => {
  it("refuses a stale exact request after lifecycle unbind", async () => {
    const f = await fixture("unbind");
    await adoptManagedSession(f.host, f.request);
    f.stateMgr.unbindSurface(f.agent.agent_id, "lifecycle-unbind");
    await expect(adoptManagedSession(f.host, f.request)).rejects.toThrow(/invalidated|changed/);
    expect(f.stateMgr.readState(f.agent.agent_id)?.surface_uuid).toBeNull();
    const fresh = { ...f.request, expected_agent_version: f.stateMgr.readState(f.agent.agent_id)!.version };
    expect((await adoptManagedSession(f.host, fresh)).status).toBe("adopted");
  });
  it("repairs real routing persistence after both post-state index failures", async () => {
    const f = await fixture("index"); const index = f.stateMgr.getSurfaceSessionIndex();
    const persist = index.persistRecord.bind(index); let failures = 2;
    vi.spyOn(index, "persistRecord").mockImplementation(record => {
      if (failures-- > 0) throw new Error("original routing-index failure"); return persist(record);
    });
    for (let i = 0; i < 2; i++) {
      expect(await adoptManagedSession(f.host, f.request)).toMatchObject({ status: "pending_verify", error: "Error: original routing-index failure" });
    }
    expect((await adoptManagedSession(f.host, f.request)).status).toBe("adopted");
    const reloaded = new StateManager(f.dir);
    expect(reloaded.getSurfaceSessionIndex().lookup({ workspace_id: "workspace:current", surface_id: "surface:new" })).toMatchObject({ agent_id: f.agent.agent_id, cli_session_id: f.agent.cli_session_id });
    const version = reloaded.readState(f.agent.agent_id)!.version;
    expect((await adoptManagedSession(f.host, f.request)).idempotent).toBe(true);
    expect(reloaded.readState(f.agent.agent_id)!.version).toBe(version);
  });
  it("retains pending status and the primary completion-index error when cleanup also fails", async () => {
    const f = await fixture("completion-index"), index = f.stateMgr.getSurfaceSessionIndex();
    const persist = index.persistRecord.bind(index); let attempt = 0;
    vi.spyOn(index, "persistRecord").mockImplementation(record => {
      attempt++;
      if (attempt === 2) throw new Error("primary completion-index failure");
      if (attempt === 3) throw new Error("secondary cleanup failure");
      return persist(record);
    });
    expect(await adoptManagedSession(f.host, f.request)).toMatchObject({ status: "pending_verify", error: "Error: primary completion-index failure" });
    expect(f.stateMgr.readState(f.agent.agent_id)?.session_adoption?.status).toBe("pending_verify");
    expect((await adoptManagedSession(f.host, f.request)).status).toBe("adopted");
    expect(new StateManager(f.dir).getSurfaceSessionIndex().lookup({ workspace_id: "workspace:current", surface_id: "surface:new" })?.agent_id).toBe(f.agent.agent_id);
  });
  it("repairs missing routing despite a retained adopted marker", async () => {
    const f = await fixture("adopted-marker"); await adoptManagedSession(f.host, f.request);
    f.stateMgr.getSurfaceSessionIndex().removeAgent(f.agent.agent_id);
    expect((await adoptManagedSession(f.host, f.request)).status).toBe("adopted");
    expect(new StateManager(f.dir).getSurfaceSessionIndex().lookup({ workspace_id: "workspace:current", surface_id: "surface:new" })?.agent_id).toBe(f.agent.agent_id);
  });
  it.each(["alias-to-managed", "managed-to-alias"])("deduplicates the actual public send path and persisted reload (%s)", async direction => {
    const f = await fixture(direction), autoId = "auto-codex-current";
    const auto = { ...f.agent, agent_id: autoId, role: "worker" as const, authority: "worker" as const, placement: "right" as const,
      surface_id: "surface:new", surface_uuid: surface, workspace_id: "workspace:current", cli_session_id: null,
      boot_prompt_pending: false, prompt_delivered: true };
    f.stateMgr.writeState(auto); f.registry.set(autoId, auto);
    const receiptOwner = direction === "alias-to-managed" ? autoId : f.agent.agent_id;
    const retryId = direction === "alias-to-managed" ? f.agent.agent_id : autoId;
    let engine = new AgentEngine(f.stateMgr, f.registry, {} as any, { inboxOpts: { baseDir: f.dir } }); engines.push(engine);
    const receipt = engine.acceptPendingVerify({ delivery_id: "preserved-delivery", agent_id: receiptOwner, text: "Preserve these words", press_enter: true, source_event: "send_to", retry_count: 0 });
    await adoptManagedSession(f.host, f.request);
    for (let reload = 0; reload < 2; reload++) {
      if (reload) {
        const state = new StateManager(f.dir), registry = new AgentRegistry(state, async () => [{ ref: "surface:new", id: surface, workspace_ref: "workspace:current" }] as any, { observerId: "current" });
        await registry.reconstitute();
        engine = new AgentEngine(state, registry, {} as any, { inboxOpts: { baseDir: f.dir } }); engines.push(engine);
      }
      const submit = vi.fn().mockResolvedValue({ delivered: false, submitted: false, typed: false, submit_attempted: false,
        submit_verified: null, queued_behind_turn: false, delivery: "pending_verify", delivery_state: "pending_verify", rpc_methods: [], retry_count: 0, bytes: 20 }); const accept = vi.spyOn(engine, "acceptPendingVerify");
      const server = new McpServer({ name: "alias-public-send", version: "1" });
      registerSendToTool(server, { engine, registry: engine.getRegistry(), assertWorkerUpwardChannel() {}, callerOwnsTypedDraft: () => false, observePausedTarget: async () => ({ paused: false, source: "fixture" }), collectDeliveryEvidence: async () => ({}), deliverAgentInput: submit } as any);
      const result = await (server as any)._registeredTools.send_to.handler({ mode: "agent", agent_id: retryId, text: receipt.text, press_enter: true }, {});
      expect(accept).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ duplicate_of: receipt.delivery_id, delivery_id: receipt.delivery_id, delivery_state: "pending_verify" });
      expect(accept).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
      expect(engine.getDeliveryReceipt(receipt.delivery_id)).toEqual(receipt);
      await server.close();
    }
    expect(f.stateMgr.readState(f.agent.agent_id)).toMatchObject({ model: f.agent.model, effort: f.agent.effort, role: f.agent.role, authority: f.agent.authority, parent_agent_id: f.agent.parent_agent_id, boot_prompt_pending: true, prompt_delivered: false });
  });
});
