import type { CmuxServerContext } from "../server.js";
import type { Policy, SecureToolContext, Redactor } from "../secure/policy-schema.js";
import { isAllowedPrefix } from "../secure/tool-policy.js";
import { checkCommandText } from "../secure/command-guard.js";

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function err(error: unknown, extra: Record<string, unknown> = {}): AgentToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message, ...extra }),
      },
    ],
    isError: true,
  };
}

function isAgentAllowed(agentId: string, policy: Policy): boolean {
  const prefixes = policy.agents?.allowed_prefixes ?? [];
  if (prefixes.length === 0) return true;
  return isAllowedPrefix(agentId, prefixes);
}

function redactText(text: string, redactor: Redactor): string {
  return redactor.redact(text);
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────
export interface SecureAgentTools {
  "agent.list": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
  "agent.status": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
  "agent.read": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
  "agent.send_task": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
  "agent.continue": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
  "agent.extract_summary": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
  "agent.extract_errors": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
  "agent.extract_next_actions": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AgentToolResult>;
}

export function createSecureAgentTools(
  context: CmuxServerContext,
  policy: Policy,
): SecureAgentTools {
  const stateMgr = context.stateMgr;
  const client = context.client;

  // ─────────────────────────────────────────────────────────
  // agent.list
  // ─────────────────────────────────────────────────────────
  async function agentList(
    _args: unknown,
    _ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    try {
      const states = stateMgr.listStates();
      const prefixes = policy.agents?.allowed_prefixes ?? [];

      const agents = states
        .filter((record) => {
          if (prefixes.length === 0) return true;
          return isAllowedPrefix(record.agent_id, prefixes);
        })
        .map((record) => ({
          id: record.agent_id,
          state: record.state,
          surface: record.surface_id,
          model: record.model ?? null,
          cli: record.cli ?? null,
          task_summary: record.task_summary ?? null,
        }));

      return ok({ agents, count: agents.length });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // agent.status
  // ─────────────────────────────────────────────────────────
  async function agentStatus(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    const params = args as Record<string, unknown>;
    const agentId = typeof params.agent_id === "string" ? params.agent_id : "";

    if (!agentId) {
      return err("Missing required 'agent_id' argument");
    }

    if (!isAgentAllowed(agentId, policy)) {
      return err(`Agent "${agentId}" does not match allowed prefixes`);
    }

    try {
      const states = stateMgr.listStates();
      const record = states.find((s) => s.agent_id === agentId);

      if (!record) {
        return err(`Agent "${agentId}" not found`);
      }

      return ok({
        agent_id: record.agent_id,
        state: record.state,
        surface: record.surface_id,
        model: record.model ?? null,
        cli: record.cli ?? null,
        task_summary: record.task_summary ?? null,
        updated_at: record.updated_at,
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // agent.read
  // ─────────────────────────────────────────────────────────
  async function agentRead(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    const params = args as Record<string, unknown>;
    const agentId = typeof params.agent_id === "string" ? params.agent_id : "";
    const lines = typeof params.lines === "number" ? params.lines : 30;

    if (!agentId) {
      return err("Missing required 'agent_id' argument");
    }

    if (!isAgentAllowed(agentId, policy)) {
      return err(`Agent "${agentId}" does not match allowed prefixes`);
    }

    try {
      // Find the agent's surface
      const states = stateMgr.listStates();
      const record = states.find((s) => s.agent_id === agentId);

      if (!record) {
        return err(`Agent "${agentId}" not found`);
      }

      const surface = record.surface_id;
      const result = await client.readScreen(surface, { lines });
      const redactedText = redactText(result.text, ctx.redactor);

      return ok({
        agent_id: agentId,
        surface,
        output: redactedText,
        lines: result.lines,
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // agent.send_task
  // ─────────────────────────────────────────────────────────
  async function agentSendTask(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    const params = args as Record<string, unknown>;
    const agentId = typeof params.agent_id === "string" ? params.agent_id : "";
    const task = typeof params.task === "string" ? params.task : "";

    if (!agentId) {
      return err("Missing required 'agent_id' argument");
    }
    if (!task) {
      return err("Missing required 'task' argument");
    }

    if (!isAgentAllowed(agentId, policy)) {
      return err(`Agent "${agentId}" does not match allowed prefixes`);
    }

    // Validate task text via command-guard
    try {
      const risk = checkCommandText(task, policy, "agent_task");
      if (risk === "confirmation_required") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "Task text requires confirmation",
                confirmation_required: true,
                agent_id: agentId,
              }),
            },
          ],
          isError: true,
        };
      }
    } catch (guardError) {
      const message =
        guardError instanceof Error
          ? guardError.message
          : String(guardError);
      return err(message);
    }

    try {
      // Find the agent's surface
      const states = stateMgr.listStates();
      const record = states.find((s) => s.agent_id === agentId);

      if (!record) {
        return err(`Agent "${agentId}" not found`);
      }

      const surface = record.surface_id;

      // Send the task to the agent's surface
      // Use the client's send method to deliver the text
      await client.send(surface, task, {});

      return ok({ status: "sent", agent_id: agentId, surface });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // agent.continue
  // ─────────────────────────────────────────────────────────
  async function agentContinue(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    const params = args as Record<string, unknown>;
    const agentId = typeof params.agent_id === "string" ? params.agent_id : "";
    const instruction =
      typeof params.instruction === "string" ? params.instruction : "continue";

    if (!agentId) {
      return err("Missing required 'agent_id' argument");
    }

    if (!isAgentAllowed(agentId, policy)) {
      return err(`Agent "${agentId}" does not match allowed prefixes`);
    }

    // Validate instruction text via command-guard
    if (instruction && instruction !== "continue") {
      try {
        const risk = checkCommandText(instruction, policy, "agent_task");
        if (risk === "confirmation_required") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Instruction requires confirmation",
                  confirmation_required: true,
                  agent_id: agentId,
                }),
              },
            ],
            isError: true,
          };
        }
      } catch (guardError) {
        const message =
          guardError instanceof Error
            ? guardError.message
            : String(guardError);
        return err(message);
      }
    }

    try {
      // Find the agent's surface
      const states = stateMgr.listStates();
      const record = states.find((s) => s.agent_id === agentId);

      if (!record) {
        return err(`Agent "${agentId}" not found`);
      }

      const surface = record.surface_id;

      // Send the continue instruction
      await client.send(surface, instruction, {});

      return ok({ status: "sent", agent_id: agentId, surface });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // agent.extract_summary
  // ─────────────────────────────────────────────────────────
  async function agentExtractSummary(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    const params = args as Record<string, unknown>;
    const agentId = typeof params.agent_id === "string" ? params.agent_id : "";

    if (!agentId) {
      return err("Missing required 'agent_id' argument");
    }

    if (!isAgentAllowed(agentId, policy)) {
      return err(`Agent "${agentId}" does not match allowed prefixes`);
    }

    try {
      // Find the agent's surface and read screen
      const states = stateMgr.listStates();
      const record = states.find((s) => s.agent_id === agentId);

      if (!record) {
        return err(`Agent "${agentId}" not found`);
      }

      const surface = record.surface_id;
      const result = await client.readScreen(surface, { lines: 50 });
      const text = result.text;

      // Parse screen for summary extraction
      const { parseScreen } = await import("../screen-parser.js");
      const parsed = parseScreen(text);

      // Try to find a summary in the screen text
      // Look for common summary patterns
      let summary = "";

      // Pattern 1: "Summary:" followed by text
      const summaryMatch = text.match(/(?:Summary|Overview|Result)[:\s]*([^\n]{10,500})/i);
      if (summaryMatch) {
        summary = summaryMatch[1]!.trim();
      }

      // Pattern 2: Response section from parsed screen
      if (!summary && parsed.response) {
        summary = parsed.response;
      }

      // Pattern 3: Done signal
      if (!summary && parsed.done_signal) {
        summary = `Task completed: ${parsed.done_signal}`;
      }

      // Pattern 4: Last non-empty lines as fallback
      if (!summary) {
        const lines = text.split("\n").filter((l) => l.trim().length > 10);
        const lastLines = lines.slice(-5);
        summary = lastLines.join(" ").trim().slice(0, 500);
      }

      const redactedSummary = redactText(summary, ctx.redactor);

      return ok({
        agent_id: agentId,
        summary: redactedSummary,
        agent_type: parsed.agent_type,
        status: parsed.status,
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // agent.extract_errors
  // ─────────────────────────────────────────────────────────
  async function agentExtractErrors(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    const params = args as Record<string, unknown>;
    const agentId = typeof params.agent_id === "string" ? params.agent_id : "";

    if (!agentId) {
      return err("Missing required 'agent_id' argument");
    }

    if (!isAgentAllowed(agentId, policy)) {
      return err(`Agent "${agentId}" does not match allowed prefixes`);
    }

    try {
      // Find the agent's surface and read screen
      const states = stateMgr.listStates();
      const record = states.find((s) => s.agent_id === agentId);

      if (!record) {
        return err(`Agent "${agentId}" not found`);
      }

      const surface = record.surface_id;
      const result = await client.readScreen(surface, { lines: 50 });
      const text = result.text;

      const { parseScreen } = await import("../screen-parser.js");
      const parsed = parseScreen(text);

      // Collect errors from parsed output
      const errors: string[] = [...(parsed.errors ?? [])];

      // Look for error patterns in the raw text
      const errorPatterns = [
        /Error[:\s]+([^\n]+)/gi,
        /error[:\s]+([^\n]+)/gi,
        /failed[:\s]+([^\n]+)/gi,
        /FAIL[:\s]+([^\n]+)/gi,
        /✖\s*([^\n]+)/g,
        /❌\s*([^\n]+)/g,
        /ERR!\s*([^\n]+)/gi,
        /exit\s+code[:\s]*(\d+)/gi,
        /Exception[:\s]+([^\n]+)/gi,
        /Traceback[^\n]*/gi,
        /fatal[:\s]+([^\n]+)/gi,
        /cannot\s+([^\n]+)/gi,
        /unable\s+to\s+([^\n]+)/gi,
        /permission\s+denied/gi,
        /not\s+found/gi,
        /ENOENT/g,
        /EACCES/g,
      ];

      for (const pattern of errorPatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const errorText = match[0]?.trim();
          if (errorText && errorText.length > 3 && !errors.includes(errorText)) {
            errors.push(errorText);
          }
        }
      }

      // Redact all error strings
      const redactedErrors = errors.map((e) => redactText(e, ctx.redactor));

      return ok({
        agent_id: agentId,
        errors: redactedErrors,
        error_count: redactedErrors.length,
        agent_type: parsed.agent_type,
        status: parsed.status,
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // agent.extract_next_actions
  // ─────────────────────────────────────────────────────────
  async function agentExtractNextActions(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AgentToolResult> {
    const params = args as Record<string, unknown>;
    const agentId = typeof params.agent_id === "string" ? params.agent_id : "";

    if (!agentId) {
      return err("Missing required 'agent_id' argument");
    }

    if (!isAgentAllowed(agentId, policy)) {
      return err(`Agent "${agentId}" does not match allowed prefixes`);
    }

    try {
      // Find the agent's surface and read screen
      const states = stateMgr.listStates();
      const record = states.find((s) => s.agent_id === agentId);

      if (!record) {
        return err(`Agent "${agentId}" not found`);
      }

      const surface = record.surface_id;
      const result = await client.readScreen(surface, { lines: 50 });
      const text = result.text;

      const { parseScreen } = await import("../screen-parser.js");
      const parsed = parseScreen(text);

      // Collect actions from parsed output
      const actions: string[] = [...(parsed.actions ?? [])];

      // Look for action patterns in the raw text
      const actionPatterns = [
        // "Next:" or "Next steps:" followed by content
        /(?:Next|Next steps|Next actions)[:\s]+([^\n]+)/gi,
        // "TODO:" markers
        /TODO[:\s]+([^\n]+)/gi,
        // "FIXME:" markers
        /FIXME[:\s]+([^\n]+)/gi,
        // Numbered action lists: "1. Do something" or "1) Do something"
        /^\s*\d+[.\)]\s+(.{5,200})$/gim,
        // Bullet point action items
        /^\s*[-•*]\s+(.{5,200})$/gim,
        // "Action:" markers
        /Action[:\s]+([^\n]+)/gi,
        // "Step N:" markers
        /Step\s+\d+[:\s]+([^\n]+)/gi,
        // "Plan:" markers
        /Plan[:\s]+([^\n]+)/gi,
      ];

      for (const pattern of actionPatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const actionText = (match[1] ?? match[0])?.trim();
          if (
            actionText &&
            actionText.length > 4 &&
            !actions.includes(actionText)
          ) {
            actions.push(actionText);
          }
        }
      }

      // Limit to reasonable number
      const limitedActions = actions.slice(0, 20);
      const redactedActions = limitedActions.map((a) => redactText(a, ctx.redactor));

      return ok({
        agent_id: agentId,
        actions: redactedActions,
        action_count: redactedActions.length,
        agent_type: parsed.agent_type,
        status: parsed.status,
      });
    } catch (e) {
      return err(e);
    }
  }

  return {
    "agent.list": agentList,
    "agent.status": agentStatus,
    "agent.read": agentRead,
    "agent.send_task": agentSendTask,
    "agent.continue": agentContinue,
    "agent.extract_summary": agentExtractSummary,
    "agent.extract_errors": agentExtractErrors,
    "agent.extract_next_actions": agentExtractNextActions,
  };
}
