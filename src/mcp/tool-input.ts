// Tool-input checks shared by the MCP tool handlers (moved out of server.ts,
// CX-3b S10b).

import { z } from "zod";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { SEND_TO_WORKING_EXAMPLE } from "./schemas.js";

export async function preflightBootPromptFile(path: string): Promise<void> {
  try {
    await access(path, fsConstants.R_OK);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "ERROR";
    if (code === "ENOENT") {
      throw new Error(`boot_prompt_path ENOENT: ${path}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`boot_prompt_path permission denied: ${path}`);
    }
    throw error;
  }
}

export function formatToolValidationError(
  toolName: string,
  error: z.ZodError,
): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  const example = toolName === "send_to" ? ` ${SEND_TO_WORKING_EXAMPLE}` : "";
  return `${toolName} invalid arguments: ${details}.${example}`;
}
