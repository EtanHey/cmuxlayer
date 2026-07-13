const ACCESS_CONTROL_DENIED_RE =
  /(?:\bAccess denied\b|only processes started inside cmux can connect)/i;

export function isCmuxAccessControlDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ACCESS_CONTROL_DENIED_RE.test(message);
}
