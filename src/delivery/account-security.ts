import { isCodexAccountSecurityBanner, parseScreen } from "../screen-parser.js";
import { sleep } from "../util/sleep.js";
import { DeliverySafetyGateError } from "./receipts.js";

/** Esc only, once. A reread is required before any other input or readiness. */
export async function dismissAccountSecurityBanner<T extends { text: string }>(
  screen: T,
  io: { escape: () => Promise<void>; read: () => Promise<T> },
): Promise<T> {
  if (!isCodexAccountSecurityBanner(screen.text)) return screen;
  await io.escape();
  await sleep(100);
  const closed = await io.read();
  if (isCodexAccountSecurityBanner(closed.text)) {
    throw new DeliverySafetyGateError("account_security_banner_not_dismissed", parseScreen(closed.text));
  }
  return closed;
}
