// Output limiting and request utilities

import { createHash, randomBytes } from "node:crypto";

/**
 * Truncate text so it does not exceed the given line and character limits.
 * When truncation occurs a notice line is appended indicating what was removed.
 *
 * @param text      – raw output text
 * @param maxLines  – maximum number of lines to retain
 * @param maxChars  – maximum number of characters to retain
 * @returns possibly-truncated text with a notice when capped
 */
export function truncateOutput(
  text: string,
  maxLines: number,
  maxChars: number,
): string {
  if (!text) return "";

  let result = text;

  // Apply character limit first
  if (result.length > maxChars) {
    const truncated = result.slice(0, maxChars);
    // Truncate at the last newline to avoid breaking mid-line
    const lastNewline = truncated.lastIndexOf("\n");
    if (lastNewline > maxChars * 0.8) {
      result = truncated.slice(0, lastNewline);
    } else {
      result = truncated;
    }
    const remainingLines = text.slice(result.length).split("\n").length - 1;
    const remainingChars = text.length - result.length;
    result += `\n... truncated (${remainingLines} lines, ${remainingChars} chars omitted)`;
  }

  // Then apply line limit
  const lines = result.split("\n");
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const dropped = lines.length - maxLines;
    const droppedChars = text.length - kept.join("\n").length;
    result =
      kept.join("\n") +
      `\n... truncated (${dropped} lines, ${droppedChars} chars omitted)`;
  }

  return result;
}

/**
 * Return a SHA-256 hex digest of the input string.
 *
 * @param input – the string to hash
 * @returns 64-character lowercase hex string
 */
export function hashInput(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Generate a unique request identifier.
 *
 * Format: `req_<timestamp>_<randomHex>`
 *
 * @returns request id string
 */
export function createRequestId(): string {
  const timestamp = Date.now();
  const random = randomBytes(16).toString("hex");
  return `req_${timestamp}_${random}`;
}
