import { describe, it, expect } from "vitest";
import {
  checkToolAccess,
  getToolDecision,
  isAllowedPrefix,
  filterByPrefix,
} from "../../src/secure/tool-policy.js";
import type { Policy, ToolDecision } from "../../src/secure/policy-schema.js";

const testPolicy: Policy = {
  project: {
    root: "/tmp/test-project",
    max_file_read_bytes: 10000,
    max_search_results: 50,
    deny: [],
  },
  tools: {
    allow: ["project.*", "system.*", "cmux.*"],
    require_confirmation: ["cmux.send_text", "cmux.exec*"],
    deny: ["shell.*", "fs.write*", "network.*"],
  },
};

describe("tool-policy", () => {
  describe("checkToolAccess", () => {
    it('should allow "system.health"', () => {
      const result = checkToolAccess("system.health", testPolicy);
      expect(result).toBe("allowed");
    });

    it('should allow "system.info"', () => {
      const result = checkToolAccess("system.info", testPolicy);
      expect(result).toBe("allowed");
    });

    it('should allow "project.read_file"', () => {
      const result = checkToolAccess("project.read_file", testPolicy);
      expect(result).toBe("allowed");
    });

    it('should deny "shell.exec"', () => {
      const result = checkToolAccess("shell.exec", testPolicy);
      expect(result).toBe("denied");
    });

    it('should deny "shell.bash"', () => {
      const result = checkToolAccess("shell.bash", testPolicy);
      expect(result).toBe("denied");
    });

    it('should deny "unknown.tool" when not in allow list', () => {
      const result = checkToolAccess("unknown.tool", testPolicy);
      expect(result).toBe("denied");
    });

    it('should return confirmation_required for "cmux.send_text"', () => {
      const result = checkToolAccess("cmux.send_text", testPolicy);
      expect(result).toBe("confirmation_required");
    });

    it('should return confirmation_required for "cmux.exec_command"', () => {
      const result = checkToolAccess("cmux.exec_command", testPolicy);
      expect(result).toBe("confirmation_required");
    });

    it('should deny tools matching deny list even if in allow list', () => {
      // "shell.*" is in deny list - any shell tool should be denied
      const result = checkToolAccess("shell.anything", testPolicy);
      expect(result).toBe("denied");
    });

    it("should deny by default when allow list is empty", () => {
      const emptyAllowPolicy: Policy = {
        project: {
          root: "/tmp/test",
          max_file_read_bytes: 10000,
          max_search_results: 50,
          deny: [],
        },
        tools: {
          allow: [],
          require_confirmation: [],
          deny: [],
        },
      };
      const result = checkToolAccess("any.tool", emptyAllowPolicy);
      expect(result).toBe("denied");
    });

    it('should deny "fs.write_file" matching deny pattern', () => {
      const result = checkToolAccess("fs.write_file", testPolicy);
      expect(result).toBe("denied");
    });

    it('should allow "cmux.read_screen" (allowed, not requiring confirmation)', () => {
      const result = checkToolAccess("cmux.read_screen", testPolicy);
      expect(result).toBe("allowed");
    });
  });

  describe("getToolDecision", () => {
    it("should return decision and reason for denied tool", () => {
      const result = getToolDecision("shell.exec", testPolicy);
      expect(result.decision).toBe("denied");
      expect(result.reason).toContain("deny list");
    });

    it("should return decision and reason for allowed tool", () => {
      const result = getToolDecision("system.health", testPolicy);
      expect(result.decision).toBe("allowed");
      expect(result.reason).toContain("allow list");
    });

    it("should return decision and reason for confirmation-required tool", () => {
      const result = getToolDecision("cmux.send_text", testPolicy);
      expect(result.decision).toBe("confirmation_required");
      expect(result.reason).toContain("confirmation");
    });

    it("should return reason for denied-by-default tool", () => {
      const result = getToolDecision("unknown.tool", testPolicy);
      expect(result.decision).toBe("denied");
      expect(result.reason).toBeDefined();
    });
  });

  describe("isAllowedPrefix", () => {
    it('should return true for "petpals-codex" matching "petpals-"', () => {
      const result = isAllowedPrefix("petpals-codex", ["petpals-", "cao-"]);
      expect(result).toBe(true);
    });

    it('should return true for "cao-agent" matching "cao-"', () => {
      const result = isAllowedPrefix("cao-agent", ["petpals-", "cao-"]);
      expect(result).toBe(true);
    });

    it('should return false for "personal-shell" not matching any prefix', () => {
      const result = isAllowedPrefix("personal-shell", ["petpals-", "cao-"]);
      expect(result).toBe(false);
    });

    it('should match wildcard "project.*" against "project.read_file"', () => {
      const result = isAllowedPrefix("project.read_file", ["project.*"]);
      expect(result).toBe(true);
    });

    it('should match "system." prefix against "system.health"', () => {
      const result = isAllowedPrefix("system.health", ["system."]);
      expect(result).toBe(true);
    });

    it('should return false when name does not match prefix', () => {
      const result = isAllowedPrefix("other.tool", ["project.*", "system."]);
      expect(result).toBe(false);
    });

    it("should return true for exact match", () => {
      const result = isAllowedPrefix("exact.tool", ["exact.tool"]);
      expect(result).toBe(true);
    });

    it('should return true for "*" wildcard matching everything', () => {
      const result = isAllowedPrefix("anything.at.all", ["*"]);
      expect(result).toBe(true);
    });

    it("should return false when name is empty", () => {
      const result = isAllowedPrefix("", ["project.*"]);
      expect(result).toBe(false);
    });

    it("should return false when prefixes is empty array", () => {
      const result = isAllowedPrefix("test", []);
      expect(result).toBe(false);
    });

    it("should skip empty prefix strings", () => {
      const result = isAllowedPrefix("test", ["", "test"]);
      expect(result).toBe(true);
    });
  });

  describe("filterByPrefix", () => {
    it("should filter items by name property", () => {
      const items = [
        { name: "petpals-alpha", ref: "a" },
        { name: "personal-beta", ref: "b" },
        { name: "petpals-gamma", ref: "c" },
        { name: "other-delta", ref: "d" },
      ];
      const result = filterByPrefix(items, ["petpals-"]);
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.name)).toEqual(["petpals-alpha", "petpals-gamma"]);
    });

    it("should filter items by custom key function", () => {
      const items = [
        { id: "ws-1", title: "workspace one" },
        { id: "ws-2", title: "workspace two" },
        { id: "other-1", title: "other" },
      ];
      const result = filterByPrefix(
        items,
        (item) => item.id,
        ["ws-"],
      );
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id)).toEqual(["ws-1", "ws-2"]);
    });

    it("should return empty array when no items match", () => {
      const items = [{ name: "alpha" }, { name: "beta" }];
      const result = filterByPrefix(items, ["gamma"]);
      expect(result).toHaveLength(0);
    });

    it("should return empty array for empty input", () => {
      const result = filterByPrefix([], ["project.*"]);
      expect(result).toHaveLength(0);
    });

    it("should return empty array when prefixes is empty", () => {
      const items = [{ name: "project-test" }];
      const result = filterByPrefix(items, []);
      expect(result).toHaveLength(0);
    });

    it("should filter by ref when name and title are absent", () => {
      const items = [
        { ref: "surface-1" },
        { ref: "surface-2" },
        { ref: "other-1" },
      ];
      const result = filterByPrefix(items, ["surface-"]);
      expect(result).toHaveLength(2);
    });

    it("should filter by title when name is absent", () => {
      const items = [
        { title: "terminal-one" },
        { title: "terminal-two" },
        { title: "browser-one" },
      ];
      const result = filterByPrefix(items, ["terminal-"]);
      expect(result).toHaveLength(2);
    });

    it("should prefer name over title and ref", () => {
      const items = [
        { name: "petpals-a", title: "other-b", ref: "other-c" },
        { name: "other-x", title: "petpals-y", ref: "petpals-z" },
      ];
      const result = filterByPrefix(items, ["petpals-"]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("petpals-a");
    });
  });
});
