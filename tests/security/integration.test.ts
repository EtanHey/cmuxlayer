import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import { wrapTool } from "../../src/secure/tool-wrapper.js";
import { createDefaultRedactor } from "../../src/secure/redactor.js";
import { createAuditLogger } from "../../src/secure/audit.js";
import { checkToolAccess, isAllowedPrefix } from "../../src/secure/tool-policy.js";
import type { SecureToolContext, Policy } from "../../src/secure/policy-schema.js";
import type { CmuxServerContext } from "../../src/server.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const AUDIT_PATH = "/tmp/chatgpt-mcp-cmux-test-audit.jsonl";

const TEST_POLICY: Policy = {
  project: {
    root: "/tmp/test-project",
    max_file_read_bytes: 1000,
    max_search_results: 10,
    deny: [".env", "*.pem"],
  },
  workspaces: { allowed_prefixes: ["ws-"] },
  agents: { allowed_prefixes: ["agent-", "petpals-"] },
  surfaces: { allowed_name_prefixes: ["main", "petpals-"] },
  tools: {
    allow: ["system.health", "project.info", "agent.list", "agent.send_task"],
    require_confirmation: ["agent.send_task"],
    deny: ["shell.exec", "send_command"],
  },
  commands: {
    deny_patterns: ["sudo", "rm -rf /"],
    require_confirmation_patterns: ["git push"],
  },
  audit: {
    path: AUDIT_PATH,
    redact_secrets: true,
    log_full_inputs: false,
    log_input_preview_chars: 50,
  },
  limits: {
    max_output_lines: 10,
    max_screen_chars: 1000,
    max_request_body_bytes: 10000,
    tool_timeout_ms: 5000,
    max_concurrent_requests: 3,
  },
};

const WILDCARD_POLICY: Policy = {
  project: {
    root: "/tmp/test-project",
    max_file_read_bytes: 1000,
    max_search_results: 10,
    deny: [],
  },
  tools: {
    allow: ["system.*"],
    require_confirmation: [],
    deny: [],
  },
};

// Minimal mock server context — tests do not touch these fields
const mockServerContext = {
  client: {} as CmuxServerContext["client"],
  stateDir: "/tmp/test-state",
  stateMgr: {} as CmuxServerContext["stateMgr"],
  roleSurfaceOverrides: new Map(),
  eventLog: {} as CmuxServerContext["eventLog"],
  deliveries: new Map(),
  latestDeliveryBySurface: new Map(),
  activeDeliveryBySurface: new Map(),
  activeSurfaceWrites: new Map(),
  enableClaudeChannels: false,
  skipAgentLifecycle: true,
  lifecycleRegistry: null,
  lifecycleStarted: false,
  lifecycleStartPromise: null,
  lifecycleSweepEngine: null,
  controlHealthIntervalMs: 60000,
  controlHealthTimer: null,
  dispose() {},
} as CmuxServerContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestContext(policy: Policy): SecureToolContext {
  return {
    policy,
    auditLogger: createAuditLogger(policy),
    redactor: createDefaultRedactor(),
    requestId: "test-req-001",
    mode: "test",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("security integration", () => {
  afterEach(() => {
    // Clean up audit file after each test
    if (existsSync(AUDIT_PATH)) {
      try {
        unlinkSync(AUDIT_PATH);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  describe("wrapTool", () => {
    it("allowed tool executes and returns result", async () => {
      const ctx = createTestContext(TEST_POLICY);
      const wrapped = wrapTool(
        {
          toolName: "system.health",
          schema: z.object({}),
          handler: async () => ({
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
          }),
        },
        ctx,
        mockServerContext,
      );

      const result = await wrapped.handler({});

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("true");
    });

    it("denied tool returns error without executing handler", async () => {
      const ctx = createTestContext(TEST_POLICY);
      let handlerCalled = false;

      const wrapped = wrapTool(
        {
          toolName: "shell.exec",
          schema: z.object({}),
          handler: async () => {
            handlerCalled = true;
            throw new Error("SHOULD NOT REACH");
          },
        },
        ctx,
        mockServerContext,
      );

      const result = await wrapped.handler({});

      expect(handlerCalled).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not allowed");
    });

    it("confirmation_required tool returns appropriate response", async () => {
      const ctx = createTestContext(TEST_POLICY);
      let handlerCalled = false;

      const wrapped = wrapTool(
        {
          toolName: "agent.send_task",
          schema: z.object({}),
          handler: async () => {
            handlerCalled = true;
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
            };
          },
        },
        ctx,
        mockServerContext,
      );

      const result = await wrapped.handler({});

      expect(handlerCalled).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("confirmation_required");
      expect(result.content[0].text).toContain("agent.send_task");
    });

    it("unknown tool is denied", async () => {
      const ctx = createTestContext(TEST_POLICY);

      const wrapped = wrapTool(
        {
          toolName: "unknown.mystery_tool",
          schema: z.object({}),
          handler: async () => ({
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
          }),
        },
        ctx,
        mockServerContext,
      );

      const result = await wrapped.handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not allowed");
    });

    it("output is redacted", async () => {
      const ctx = createTestContext(TEST_POLICY);
      const secretValue = "sk-test-redact-me-12345678901234567890";

      const wrapped = wrapTool(
        {
          toolName: "project.info",
          schema: z.object({}),
          handler: async () => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ status: "ok", secret: secretValue }),
              },
            ],
          }),
        },
        ctx,
        mockServerContext,
      );

      const result = await wrapped.handler({});

      expect(result.content[0].text).not.toContain(secretValue);
      expect(result.content[0].text).toContain("[REDACTED_SECRET]");
    });

    it("audit event is written", async () => {
      const ctx = createTestContext(TEST_POLICY);

      const wrapped = wrapTool(
        {
          toolName: "system.health",
          schema: z.object({}),
          handler: async () => ({
            content: [{ type: "text" as const, text: JSON.stringify({ healthy: true }) }],
          }),
        },
        ctx,
        mockServerContext,
      );

      await wrapped.handler({ check: "disk" });

      const events = await ctx.auditLogger.recent(1);
      expect(events).toHaveLength(1);
      expect(events[0].tool).toBe("system.health");
      expect(events[0].decision).toBe("allowed");
      expect(events[0].request_id).toBe("test-req-001");
      expect(events[0].mode).toBe("test");
    });
  });

  describe("isAllowedPrefix", () => {
    it("blocks non-allowed agent prefixes", () => {
      expect(isAllowedPrefix("personal-agent", ["petpals-", "agent-"])).toBe(false);
    });

    it("allows matching agent prefixes", () => {
      expect(isAllowedPrefix("petpals-codex", ["petpals-"])).toBe(true);
      expect(isAllowedPrefix("agent-worker-1", ["petpals-", "agent-"])).toBe(true);
    });

    it("blocks prefix that does not match any allowed prefix", () => {
      expect(isAllowedPrefix("malicious-actor", ["petpals-", "agent-"])).toBe(false);
    });
  });

  describe("checkToolAccess wildcard matching", () => {
    it('allows "system.health" with "system.*" wildcard', () => {
      const result = checkToolAccess("system.health", WILDCARD_POLICY);
      expect(result).toBe("allowed");
    });

    it('allows "system.info" with "system.*" wildcard', () => {
      const result = checkToolAccess("system.info", WILDCARD_POLICY);
      expect(result).toBe("allowed");
    });

    it('denies "project.read_file" when only "system.*" is allowed', () => {
      const result = checkToolAccess("project.read_file", WILDCARD_POLICY);
      expect(result).toBe("denied");
    });

    it('denies "shell.exec" when only "system.*" is allowed', () => {
      const result = checkToolAccess("shell.exec", WILDCARD_POLICY);
      expect(result).toBe("denied");
    });
  });
});
