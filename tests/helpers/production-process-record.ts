import { AgentEngine } from "../../src/agent-engine.js";
import type { AgentRecord, AgentState } from "../../src/agent-types.js";
import type { CmuxClient } from "../../src/cmux-client.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { makeSelfRegistrationSessionResolver } from "../../src/self-registration.js";
import { StateManager } from "../../src/state-manager.js";

const PRODUCTION_SESSION_ID = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";

/**
 * Build the record shape production emits: persist pid:null, then consume the
 * hook JSONL through AgentEngine.captureBootSessionId before state advances.
 */
export async function persistProductionProcessRecord(input: {
  stateMgr: StateManager;
  registry: AgentRegistry;
  record: AgentRecord;
  pid?: number;
  registeredAtMs?: number;
}): Promise<AgentRecord> {
  const pid = input.pid ?? process.pid;
  const registeredAtMs = input.registeredAtMs ?? Date.now();
  const targetState = input.record.state;
  const booting: AgentRecord = {
    ...input.record,
    state: "booting",
    pid: null,
    pid_registered_at: null,
    surface_provenance: "cmuxlayer_spawn",
    cli_session_id: input.record.cli_session_id ?? PRODUCTION_SESSION_ID,
    surface_uuid:
      input.record.surface_uuid ??
      "11111111-2222-4333-8444-555555555555",
  };
  input.stateMgr.writeState(booting);
  input.registry.set(booting.agent_id, booting);

  const resolver = makeSelfRegistrationSessionResolver({
    registryPath: "/test/session-registry.jsonl",
    readFile: () =>
      `${JSON.stringify({
        session_id: booting.cli_session_id,
        surface_uuid: booting.surface_uuid,
        cwd: booting.launch_cwd ?? null,
        pid,
        cli: booting.cli,
        ts: registeredAtMs,
      })}\n`,
    now: () => registeredAtMs,
  });
  const engine = new AgentEngine(
    input.stateMgr,
    input.registry,
    {
      readScreen: async () => ({ text: "", lines: 0, scrollback_used: false }),
    } as CmuxClient,
    {
      spawnPreflight: async () => {},
      selfRegistrationSessionResolver: resolver,
      sessionIdentityResolver: () => null,
    },
  );
  let captured = await engine.captureBootSessionId(booting.agent_id);
  engine.dispose();
  if (!captured) throw new Error("production process capture returned null");

  const advance = (state: AgentState): void => {
    captured = input.stateMgr.transition(captured!.agent_id, state);
    input.registry.set(captured!.agent_id, captured!);
  };
  if (targetState === "ready") advance("ready");
  if (targetState === "working") {
    advance("ready");
    advance("working");
  }
  if (targetState === "idle") {
    advance("ready");
    advance("working");
    advance("idle");
  }
  if (targetState === "done") {
    advance("ready");
    advance("working");
    advance("done");
  }
  if (targetState === "error") advance("error");
  return captured;
}
