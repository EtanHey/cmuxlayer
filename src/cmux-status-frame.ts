import type { CmuxStatusEntry } from "./types.js";

const CMUX_STATUS_FRAME_PATTERN =
  /^([^=]+)=(.*?)(?:\s+icon=([^\s]+))?(?:\s+color=(#[0-9a-fA-F]{6}))?$/;

export function parseCmuxStatusFrame(
  line: string,
): CmuxStatusEntry | null {
  const match = line.match(CMUX_STATUS_FRAME_PATTERN);
  if (!match) return null;

  const [, key, value, icon, color] = match;
  return {
    key: key ?? "",
    value: value?.trim() ?? "",
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
  };
}

export function isCmuxSidebarStatusFrame(line: string): boolean {
  const frame = parseCmuxStatusFrame(line);
  if (!frame) return false;

  return (
    frame.key.startsWith("agent-surface:") ||
    frame.icon !== undefined ||
    frame.color !== undefined
  );
}
