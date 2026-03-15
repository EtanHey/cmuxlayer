import { describe, it, expect } from "vitest";
import {
  isReadOnlyTool,
  isMutatingTool,
  assertMutationAllowed,
  parseReservedModeKey,
} from "../src/mode-policy.js";

describe("isReadOnlyTool", () => {
  it("returns true for list_surfaces", () => {
    expect(isReadOnlyTool("list_surfaces")).toBe(true);
  });

  it("returns true for read_screen", () => {
    expect(isReadOnlyTool("read_screen")).toBe(true);
  });

  it("returns false for send_input", () => {
    expect(isReadOnlyTool("send_input")).toBe(false);
  });

  it("returns false for unknown tool", () => {
    expect(isReadOnlyTool("unknown_tool")).toBe(false);
  });
});

describe("isMutatingTool", () => {
  it("returns true for send_input", () => {
    expect(isMutatingTool("send_input")).toBe(true);
  });

  it("returns true for send_key", () => {
    expect(isMutatingTool("send_key")).toBe(true);
  });

  it("returns true for close_surface", () => {
    expect(isMutatingTool("close_surface")).toBe(true);
  });

  it("returns true for browser_surface", () => {
    expect(isMutatingTool("browser_surface")).toBe(true);
  });

  it("returns false for list_surfaces", () => {
    expect(isMutatingTool("list_surfaces")).toBe(false);
  });

  it("returns false for rename_tab (metadata, not mutation)", () => {
    expect(isMutatingTool("rename_tab")).toBe(false);
  });
});

describe("assertMutationAllowed", () => {
  it("does not throw for read-only tool in manual mode", () => {
    expect(() =>
      assertMutationAllowed("list_surfaces", "manual"),
    ).not.toThrow();
    expect(() => assertMutationAllowed("read_screen", "manual")).not.toThrow();
  });

  it("does not throw for any tool in autonomous mode", () => {
    expect(() =>
      assertMutationAllowed("send_input", "autonomous"),
    ).not.toThrow();
    expect(() =>
      assertMutationAllowed("close_surface", "autonomous"),
    ).not.toThrow();
  });

  it("throws for mutating tool in manual mode", () => {
    expect(() => assertMutationAllowed("send_input", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("send_key", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("close_surface", "manual")).toThrow(
      /manual/i,
    );
  });

  it("allows metadata tools in manual mode", () => {
    expect(() => assertMutationAllowed("rename_tab", "manual")).not.toThrow();
    expect(() => assertMutationAllowed("set_status", "manual")).not.toThrow();
    expect(() => assertMutationAllowed("set_progress", "manual")).not.toThrow();
  });
});

describe("parseReservedModeKey", () => {
  it("parses mode.control key", () => {
    expect(parseReservedModeKey("mode.control", "autonomous")).toEqual({
      control: "autonomous",
    });
    expect(parseReservedModeKey("mode.control", "manual")).toEqual({
      control: "manual",
    });
  });

  it("parses mode.intent key", () => {
    expect(parseReservedModeKey("mode.intent", "chat")).toEqual({
      intent: "chat",
    });
    expect(parseReservedModeKey("mode.intent", "audit")).toEqual({
      intent: "audit",
    });
  });

  it("returns null for non-mode keys", () => {
    expect(parseReservedModeKey("agent", "running")).toBeNull();
    expect(parseReservedModeKey("task", "build")).toBeNull();
  });

  it("throws for invalid mode.control value", () => {
    expect(() => parseReservedModeKey("mode.control", "invalid")).toThrow();
  });

  it("throws for invalid mode.intent value", () => {
    expect(() => parseReservedModeKey("mode.intent", "invalid")).toThrow();
  });
});
