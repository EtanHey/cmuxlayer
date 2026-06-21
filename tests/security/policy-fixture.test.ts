import { describe, it, expect } from "vitest";
import { loadPolicySync, validatePolicy } from "../../src/secure/policy.js";
import { checkToolAccess } from "../../src/secure/tool-policy.js";
import type { Policy } from "../../src/secure/policy-schema.js";
import { resolve } from "node:path";

describe("policy-fixture", () => {
  const policyPath = resolve(process.cwd(), "config/policy.example.yaml");

  describe("config/policy.example.yaml", () => {
    it("exists and loads without error", () => {
      const policy = loadPolicySync(policyPath);
      expect(policy).toBeDefined();
      expect(policy).not.toBeNull();
    });

    it("loaded policy has all required sections", () => {
      const policy: Policy = loadPolicySync(policyPath);

      expect(typeof policy.project.root).toBe("string");
      expect(policy.project.root.length).toBeGreaterThan(0);

      expect(Array.isArray(policy.tools.allow)).toBe(true);
      expect(policy.tools.allow.length).toBeGreaterThan(0);

      expect(Array.isArray(policy.tools.deny)).toBe(true);

      expect(typeof policy.audit?.path).toBe("string");

      expect(policy.limits).toBeDefined();
      expect(typeof policy.limits?.max_output_lines).toBe("number");
      expect(typeof policy.limits?.tool_timeout_ms).toBe("number");
    });

    it("allow list contains safe tool categories via wildcards", () => {
      const policy: Policy = loadPolicySync(policyPath);
      const allowList = policy.tools.allow;

      expect(allowList).toContain("system.*");
      expect(allowList).toContain("project.*");
      expect(allowList).toContain("cmux.*");
      expect(allowList).toContain("agent.*");
      expect(allowList).toContain("audit.*");
    });

    it("deny list contains dangerous tools", () => {
      const policy: Policy = loadPolicySync(policyPath);

      expect(policy.tools.deny).toContain("system.memory_usage");
    });

    it("project root is set", () => {
      const policy: Policy = loadPolicySync(policyPath);

      expect(typeof policy.project.root).toBe("string");
      expect(policy.project.root.length).toBeGreaterThan(0);
    });

    it("deny list blocks file patterns", () => {
      const policy: Policy = loadPolicySync(policyPath);

      expect(policy.project.deny).toContain(".env*");
      expect(policy.project.deny).toContain("*.pem");
      expect(policy.project.deny).toContain("node_modules/");
    });

    it("agents prefixes exist", () => {
      const policy: Policy = loadPolicySync(policyPath);

      expect(Array.isArray(policy.agents?.allowed_prefixes)).toBe(true);
      expect(policy.agents!.allowed_prefixes.length).toBeGreaterThan(0);
    });

    it("audit config exists", () => {
      const policy: Policy = loadPolicySync(policyPath);

      expect(typeof policy.audit?.path).toBe("string");
      expect(policy.audit?.redact_secrets).toBe(true);
    });

    it("command deny patterns exist", () => {
      const policy: Policy = loadPolicySync(policyPath);

      expect(Array.isArray(policy.commands?.deny_patterns)).toBe(true);
      expect(policy.commands!.deny_patterns.length).toBeGreaterThan(0);

      const patterns = policy.commands!.deny_patterns;
      const patternStrings = patterns.map((p: string) => String(p));

      expect(patternStrings.some((p: string) => p.includes("sudo"))).toBe(true);
      expect(patternStrings.some((p: string) => p.includes("rm"))).toBe(true);
      expect(
        patternStrings.some(
          (p: string) => p.includes("curl") || p.includes("sh"),
        ),
      ).toBe(true);
    });

    it("checkToolAccess with wildcard allow", () => {
      const policy: Policy = loadPolicySync(policyPath);

      // system.* wildcard should allow system.health
      expect(checkToolAccess("system.health", policy)).toBe("allowed");

      // project.* wildcard should allow project.read_file
      expect(checkToolAccess("project.read_file", policy)).toBe("allowed");

      // agent.send_task is in require_confirmation list and matches agent.* wildcard
      expect(checkToolAccess("agent.send_task", policy)).toBe(
        "confirmation_required",
      );

      // shell.exec is not in allow list (shell.* is not allowed)
      expect(checkToolAccess("shell.exec", policy)).toBe("denied");

      // send_command is not in allow list
      expect(checkToolAccess("send_command", policy)).toBe("denied");
    });
  });
});
