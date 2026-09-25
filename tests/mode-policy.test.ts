import { describe, it, expect } from "vitest";
import {
  isReadOnlyTool,
  isMutatingTool,
  assertMutationAllowed,
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

  it("returns true for send_command", () => {
    expect(isMutatingTool("send_command")).toBe(true);
  });

  it("returns true for select_workspace", () => {
    expect(isMutatingTool("select_workspace")).toBe(true);
  });

  it("returns true for close_surface", () => {
    expect(isMutatingTool("close_surface")).toBe(true);
  });

  it("returns true for delete_workspace", () => {
    expect(isMutatingTool("delete_workspace")).toBe(true);
  });

  it("returns true for lifecycle and tab mutation tools", () => {
    expect(isMutatingTool("rename_tab")).toBe(true);
    expect(isMutatingTool("move_surface")).toBe(true);
    expect(isMutatingTool("send_to")).toBe(true);
    expect(isMutatingTool("stop_agent")).toBe(true);
    expect(isMutatingTool("agent_engine")).toBe(true);
    expect(isMutatingTool("focus_surface")).toBe(true);
  });

  it("returns false for list_surfaces", () => {
    expect(isMutatingTool("list_surfaces")).toBe(false);
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
    expect(() => assertMutationAllowed("send_command", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("select_workspace", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("close_surface", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("rename_tab", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("send_to", "manual")).toThrow(/manual/i);
    expect(() => assertMutationAllowed("boot_prompt", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("agent_engine", "manual")).toThrow(
      /manual/i,
    );
    expect(() => assertMutationAllowed("focus_surface", "manual")).toThrow(
      /manual/i,
    );
  });

  it("allows non-mutating public tools in manual mode", () => {
    expect(() => assertMutationAllowed("list_agents", "manual")).not.toThrow();
    expect(() => assertMutationAllowed("wait_for", "manual")).not.toThrow();
  });
});
