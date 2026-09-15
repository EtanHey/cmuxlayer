import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import { parseScreen } from "../src/screen-parser.js";

it("#636 keeps verifier attribution in the durable receipt and event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "636-provenance-"));
  const state = new StateManager(dir);
  const evidence = { submit_evidence: "transcript_echo", frame_hash: "a".repeat(64) };
  const engine = new AgentEngine(state, new AgentRegistry(state, async () => []), {} as any, {
    deliveryVerifier: async () => ({ outcome: "delivered", submit_verified: true, evidence }),
  });
  try {
    engine.acceptPendingVerify({ delivery_id: "provenance", agent_id: "agent", text: "observed payload", press_enter: true, source_event: "send_to", retry_count: 0 });
    await engine.verifyPendingDeliveries();
    expect(engine.getDeliveryReceipt("provenance")).toMatchObject(evidence);
    expect(JSON.parse(readFileSync(join(dir, "delivery-receipts.json"), "utf8"))[0]).toMatchObject(evidence);
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.delivery_id === "provenance")).toMatchObject(evidence);
  } finally { engine.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

it("#636 a completed tool above a nonempty Claude composer is idle", () => {
  expect(parseScreen("Claude Code\n⏺ Bash(previous tool completed)\n❯ 636 unique delivery\n").status).toBe("idle");
});

it("#636 indented shell output does not end a running Claude tool", () => {
  expect(parseScreen("Claude Code\n⏺ Bash(npm run release)\n     $ npm run build\n     > tsc --build\n").status).toBe("working");
});
