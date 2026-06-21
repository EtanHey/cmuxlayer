import type { AuditLogger, AuditEvent, SecureToolContext } from "../secure/policy-schema.js";

export interface AuditToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): AuditToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function err(error: unknown, extra: Record<string, unknown> = {}): AuditToolResult {
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

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────
export interface SecureAuditTools {
  "audit.recent": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AuditToolResult>;
  "audit.search": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<AuditToolResult>;
}

export function createSecureAuditTools(
  auditLogger: AuditLogger,
): SecureAuditTools {
  // ─────────────────────────────────────────────────────────
  // audit.recent
  // ─────────────────────────────────────────────────────────
  async function auditRecent(
    args: unknown,
    _ctx: SecureToolContext,
  ): Promise<AuditToolResult> {
    const params = args as Record<string, unknown>;
    const count = typeof params.count === "number" ? params.count : 20;
    const clampedCount = Math.min(Math.max(count, 1), 1000);

    try {
      const events = await auditLogger.recent(clampedCount);

      // Redact sensitive fields from events before returning
      const redactedEvents = events.map((event) => ({
        ...event,
        // Ensure input_preview is truncated (audit logger already redacts)
        input_preview:
          event.input_preview.length > 300
            ? event.input_preview.slice(0, 300) + "..."
            : event.input_preview,
        // Ensure result is truncated
        result:
          event.result.length > 1000
            ? event.result.slice(0, 1000) + "..."
            : event.result,
      }));

      return ok({ events: redactedEvents, count: redactedEvents.length });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // audit.search
  // ─────────────────────────────────────────────────────────
  async function auditSearch(
    args: unknown,
    ctx: SecureToolContext,
  ): Promise<AuditToolResult> {
    const params = args as Record<string, unknown>;
    const toolFilter = typeof params.tool === "string" ? params.tool : undefined;
    const decisionFilter =
      typeof params.decision === "string" ? params.decision : undefined;
    const since = typeof params.since === "string" ? params.since : undefined;

    try {
      // Read all events from the audit log
      const events = await auditLogger.recent(10000);

      // Filter events
      const filtered = events.filter((event: AuditEvent) => {
        if (toolFilter && event.tool !== toolFilter) {
          return false;
        }
        if (decisionFilter && event.decision !== decisionFilter) {
          return false;
        }
        if (since) {
          const sinceDate = new Date(since);
          const eventDate = new Date(event.ts);
          if (eventDate < sinceDate) {
            return false;
          }
        }
        return true;
      });

      // Redact sensitive fields
      const redactedEvents = filtered.map((event: AuditEvent) => ({
        ...event,
        input_preview:
          event.input_preview.length > 300
            ? event.input_preview.slice(0, 300) + "..."
            : event.input_preview,
        result:
          event.result.length > 1000
            ? event.result.slice(0, 1000) + "..."
            : event.result,
      }));

      return ok({
        events: redactedEvents,
        count: redactedEvents.length,
        filters: {
          tool: toolFilter,
          decision: decisionFilter,
          since,
        },
      });
    } catch (e) {
      return err(e);
    }
  }

  return {
    "audit.recent": auditRecent,
    "audit.search": auditSearch,
  };
}
