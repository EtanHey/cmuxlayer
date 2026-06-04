import { describe, expect, it } from "vitest";
import { formatDelivery } from "../src/format.js";

describe("formatDelivery", () => {
  it("renders a phone-readable delivered line with full identity", () => {
    const line = formatDelivery("send_command", {
      surface: "surface:95",
      title: "BL-LEAD",
      model: "Opus 4.8",
      agent_type: "claude",
      delivered: true,
      submit_verified: true,
    });
    expect(line).toContain("delivered to BL-LEAD");
    expect(line).toContain("surface:95");
    expect(line).toContain("Opus 4.8");
    expect(line).toContain("claude");
    expect(line).toContain("✓ submit_verified");
  });

  it("does not repeat the surface when there is no title", () => {
    const line = formatDelivery("send_input", {
      surface: "surface:1",
      model: "GPT-5.5",
      agent_type: "codex",
      delivered: true,
    });
    expect(line).toContain("delivered to surface:1 (GPT-5.5 · codex)");
  });

  it("omits unknown identity fields entirely", () => {
    const line = formatDelivery("send_input", {
      surface: "surface:1",
      delivered: true,
    });
    expect(line).toBe("✔ send_input ─ delivered to surface:1");
  });

  it("renders 'delivering' (never FAILED) while a send is still in flight", () => {
    const line = formatDelivery("send_input", {
      surface: "surface:7",
      delivered: false,
      pending: true,
    });
    expect(line).toContain("delivering to surface:7");
    expect(line).not.toContain("FAILED");
  });

  it("renders a clear failure line when delivery did not complete", () => {
    const line = formatDelivery("send_input", {
      surface: "surface:1",
      delivered: false,
    });
    expect(line).toContain("delivery FAILED to surface:1");
  });

  it("flags an unverified submit and a not-attempted submit distinctly", () => {
    expect(
      formatDelivery("send_command", {
        surface: "surface:1",
        delivered: true,
        submit_verified: false,
      }),
    ).toContain("✗ submit not verified");
    expect(
      formatDelivery("send_command", {
        surface: "surface:1",
        delivered: true,
        submit_verified: null,
      }),
    ).toContain("submit_verified=null (not attempted)");
  });
});
