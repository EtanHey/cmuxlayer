import { describe, expect, it } from "vitest";
import { closeSpawnedAgent } from "../scripts/soak-live-cleanup.mjs";

describe("live soak cleanup", () => {
  it("records a leak without closing a recycled ref owned by another agent", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const violations: Array<{ name: string; failures: string[]; context: Record<string, unknown> }> = [];
    const occupant = { agent_id: "foreign-agent", surface_uuid: "foreign-uuid", closed: false };
    const call = async (_tool: string, args: Record<string, unknown>) => {
      calls.push(args);
      if (args.scope === "surface" && args.force === true) {
        occupant.closed = true;
        return { ok: true, surface_closed: true };
      }
      return { ok: false, surface_closed: false, agent_stopped: false };
    };
    const check = (name: string, failures: string[], context: Record<string, unknown>) => {
      violations.push({ name, failures, context });
    };

    const result = await closeSpawnedAgent({ call, check, cycle: 1,
      agentId: "soak-agent", surface: "surface:321", surfaceUuid: "soak-uuid" });

    expect(occupant.closed).toBe(false);
    expect(calls).toEqual([
      { scope: "agent", agent_id: "soak-agent", force: true },
      { scope: "agent", agent_id: "soak-agent", force: false },
    ]);
    expect(result.leaked).toBe(true);
    expect(violations).toEqual([{ name: "cleanup", failures: ["cleanup_leak"],
      context: { cycle: 1, agent_id: "soak-agent", surface: "surface:321",
        surface_uuid: "soak-uuid", stable_identity: "soak-uuid" } }]);
  });

  it("records an unowned surface as a leak without attempting raw cleanup", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const violations: string[] = [];
    const result = await closeSpawnedAgent({
      call: async (_tool: string, args: Record<string, unknown>) => { calls.push(args); return { ok: true }; },
      check: (_name: string, failures: string[]) => { violations.push(...failures); },
      cycle: 2, agentId: null, surface: "surface:322", surfaceUuid: "unbound-uuid",
    });
    expect(calls).toEqual([]);
    expect(result.leaked).toBe(true);
    expect(violations).toEqual(["cleanup_leak"]);
  });
});
