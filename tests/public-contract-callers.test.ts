import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("in-repo public contract callers", () => {
  it("requests full control_health detail wherever the response is inspected", () => {
    const doctor = source("src/doctor.ts");
    const realContract = source("scripts/run-real-cmux-contract.ts");

    expect(doctor).toMatch(
      /params:\s*\{\s*name: "control_health",\s*arguments: \{ detail: "full" \}/,
    );
    expect(
      realContract.match(
        /peer\.callTool\(\s*"control_health",\s*\{ detail: "full" \},/g,
      ),
    ).toHaveLength(2);
  });

  it("uses the canonical send_to mode and payload fields in live probes", () => {
    const liveness = source("scripts/acceptance-registry-liveness.mjs");
    const churn = source("scripts/run-live-id-churn-probe.ts");

    expect(liveness).toMatch(
      /mcp\.call\(\s*"send_to",\s*\{\s*mode: "agent",\s*agent_id: a\.agent_id,/,
    );
    expect(churn).toContain('mode: "key",\n      surface: child.surface_id');
    expect(churn).toContain('text: "down"');
    expect(churn).toContain('text: "return"');
    expect(churn).not.toMatch(/mode: "key",[\s\S]{0,160}\bkey:/);
  });
});
