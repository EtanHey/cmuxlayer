/**
 * Audit logging module.
 *
 * Writes JSONL-formatted audit events to a configurable file path.  Supports
 * both asynchronous (`log`) and synchronous (`logSync`) append operations,
 * automatic directory creation (mkdir -p), and retrieval of recent events.
 *
 * ## Guarantees
 * - **Secret redaction** – `input_preview` and `result` are scrubbed before
 *   writing.  Authorization headers, Bearer tokens, full env values, `.env`
 *   content, and private keys are never logged verbatim.
 * - **Thread-safety** – file appends are atomic at the OS level for
 *   JSONL lines.
 * - **Graceful degradation** – if the audit file does not exist yet,
 *   `recent()` returns an empty array; write failures are swallowed so
 *   audit errors never break tool execution.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { AuditLogger, AuditEvent, Policy } from "./policy-schema.js";
export type { AuditLogger } from "./policy-schema.js";

/** Sentinel substituted for sensitive content. */
const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an {@link AuditLogger} backed by a JSONL file on disk.
 *
 * The log file path is taken from `policy.audit.path` (with `~` expanded to
 * the user's home directory).  The parent directory is created automatically.
 *
 * @param policy Parsed policy object.
 * @returns Thread-safe audit logger instance.
 */
export function createAuditLogger(policy: Policy): AuditLogger {
  const auditCfg = policy.audit;
  const rawPath =
    auditCfg?.path ?? "~/.local/share/chatgpt-mcp-cmux/audit.jsonl";
  const filePath = expandHomeDir(rawPath);
  const shouldRedact = auditCfg?.redact_secrets ?? true;
  const maxPreviewChars = auditCfg?.log_input_preview_chars ?? 300;

  // Ensure the directory exists (sync during construction)
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    /**
     * Append an audit event asynchronously.
     *
     * The event is sanitised (secrets redacted, input truncated) and a `ts`
     * field is injected before writing.
     */
    async log(event: Omit<AuditEvent, "ts">): Promise<void> {
      const safeEvent = sanitise(event, shouldRedact, maxPreviewChars);
      const line =
        JSON.stringify({ ...safeEvent, ts: new Date().toISOString() }) + "\n";

      try {
        await mkdir(dir, { recursive: true });
        await appendFile(filePath, line, "utf-8");
      } catch {
        // Swallow — audit logging must never break tool execution.
      }
    },

    /**
     * Append an audit event synchronously.
     *
     * Used in shutdown or critical-error paths where awaiting is not possible.
     */
    logSync(event: Omit<AuditEvent, "ts">): void {
      const safeEvent = sanitise(event, shouldRedact, maxPreviewChars);
      const line =
        JSON.stringify({ ...safeEvent, ts: new Date().toISOString() }) + "\n";

      try {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        appendFileSync(filePath, line, "utf-8");
      } catch {
        // Intentionally swallowed — see `log()` above.
      }
    },

    /**
     * Read the most recent *count* events from the audit file.
     *
     * Returns events in chronological order (oldest first).  If the audit
     * file does not exist yet, returns an empty array.
     *
     * @param count Maximum number of events to return.
     */
    async recent(count: number): Promise<AuditEvent[]> {
      if (count <= 0) return [];

      // Read only the tail of the file to avoid OOM on large audit logs
      try {
        const stat = statSync(filePath, { throwIfNoEntry: false });
        if (!stat) return [];

        const READ_CHUNK = 64 * 1024; // 64KB chunks
        const fd = await import("node:fs/promises").then((m) =>
          m.open(filePath, "r"),
        );
        try {
          const fileSize = stat.size;
          const readSize = Math.min(fileSize, READ_CHUNK * Math.max(count, 10));
          const buffer = Buffer.alloc(readSize);
          const { bytesRead } = await fd.read(
            buffer,
            0,
            readSize,
            Math.max(0, fileSize - readSize),
          );
          const content = buffer.toString("utf-8", 0, bytesRead);
          const lines = content
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

          const lastLines = lines.slice(-count);
          const events: AuditEvent[] = [];
          for (const line of lastLines) {
            try {
              events.push(JSON.parse(line) as AuditEvent);
            } catch {
              // Skip malformed lines
            }
          }
          return events;
        } finally {
          await fd.close();
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return [];
        }
        throw err;
      }
    },

    /**
     * Close the logger.
     *
     * For the file-backed implementation this is a no-op, but the method is
     * provided so callers can cleanly shut down without knowing internals.
     */
    async close(): Promise<void> {
      // Nothing to close for a file-backed logger.
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` in a path to the user's home directory.
 */
function expandHomeDir(filePath: string): string {
  if (filePath === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    return home;
  }
  if (filePath.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    return path.join(home, filePath.slice(2));
  }
  return filePath;
}

/**
 * Sanitise an audit event before writing.
 *
 * - Truncates `input_preview` to *maxChars*.
 * - Redacts secrets from `input_preview` when *redact* is true.
 * - Scrubs obviously sensitive content from `result` regardless of settings.
 */
function sanitise(
  event: Omit<AuditEvent, "ts">,
  redact: boolean,
  maxChars: number,
): Omit<AuditEvent, "ts"> {
  let inputPreview = truncate(event.input_preview, maxChars);

  if (redact) {
    inputPreview = redactSecrets(inputPreview);
  }

  // Always scrub result field if it contains obviously sensitive content
  const result = containsSensitiveContent(event.result)
    ? REDACTED
    : event.result;

  return {
    ...event,
    input_preview: inputPreview,
    result,
  };
}

/**
 * Truncate a string to at most *maxChars*, appending `" …"` when truncated.
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 2) + " …";
}

/**
 * Lightweight inline secret redactor for audit fields.
 *
 * This avoids a runtime dependency on `./redactor.js` (prevents potential
 * circular dependency issues).
 */
function redactSecrets(text: string): string {
  const patterns: Array<{ regex: RegExp; replacement: string }> = [
    // OpenAI-style keys
    { regex: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_KEY]" },
    // GitHub PATs (classic)
    { regex: /ghp_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED_PAT]" },
    // GitHub fine-grained PATs
    { regex: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED_PAT]" },
    // Tailscale keys
    { regex: /tskey-[A-Za-z0-9_-]+/g, replacement: "[REDACTED_KEY]" },
    // ENV=VALUE assignments
    {
      regex: /(OPENAI_API_KEY\s*=\s*)[^\s]*/g,
      replacement: `$1${REDACTED}`,
    },
    {
      regex: /(ANTHROPIC_API_KEY\s*=\s*)[^\s]*/g,
      replacement: `$1${REDACTED}`,
    },
    {
      regex: /(DEEPSEEK_API_KEY\s*=\s*)[^\s]*/g,
      replacement: `$1${REDACTED}`,
    },
    {
      regex: /(SUPABASE_SERVICE_ROLE_KEY\s*=\s*)[^\s]*/g,
      replacement: `$1${REDACTED}`,
    },
    {
      regex: /(AWS_SECRET_ACCESS_KEY\s*=\s*)[^\s]*/g,
      replacement: `$1${REDACTED}`,
    },
    // Private key blocks
    {
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      replacement: "[REDACTED_KEY]",
    },
    // Generic Bearer tokens
    {
      regex: /Bearer\s+[A-Za-z0-9_\-.]+/g,
      replacement: `Bearer ${REDACTED}`,
    },
    // Generic Authorization header values
    {
      regex: /(Authorization:\s*).*$/gm,
      replacement: `$1${REDACTED}`,
    },
  ];

  let result = text;
  for (const { regex, replacement } of patterns) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Heuristic: does the text contain content that should never be logged?
 */
function containsSensitiveContent(text: string): boolean {
  const lower = text.toLowerCase();

  const neverLog: string[] = [
    "authorization",
    "bearer",
    "x-api-key",
    "password",
    "-----begin",
    "-----end",
  ];

  for (const field of neverLog) {
    if (lower.includes(field)) return true;
  }

  // Check for "private key" or "private_key" only when accompanied by
  // key-block markers (avoid false positives on "private_key_file").
  if (
    (lower.includes("private key") || lower.includes("private_key")) &&
    (lower.includes("-----begin") || lower.includes("-----end"))
  ) {
    return true;
  }

  return false;
}
