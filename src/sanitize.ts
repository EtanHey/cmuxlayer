/**
 * Strip dangerous terminal control sequences from text before sending to panes.
 * Preserves newline (\n), tab (\t), and carriage return (\r).
 * Strips: ESC sequences, BEL, and other C0/C1 control characters.
 */
export function sanitizeTerminalInput(text: string): string {
  // Strip ANSI escape sequences (ESC [ ... letter, ESC ] ... BEL/ST, ESC ( ..., etc.)
  let result = text.replace(/\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`]/g, "");
  // Strip remaining ESC + any following char
  result = result.replace(/\x1b./g, "");
  // Strip standalone ESC
  result = result.replace(/\x1b/g, "");
  // Strip C0 control chars except HT(0x09), LF(0x0a), CR(0x0d)
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Strip C1 control chars (0x80-0x9f)
  result = result.replace(/[\x80-\x9f]/g, "");
  return result;
}
