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
  let observed = screen;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(200);
    observed = await io.read();
    if (!isCodexAccountSecurityBanner(observed.text)) return observed;
  }
  throw new DeliverySafetyGateError("account_security_banner_not_dismissed", parseScreen(observed.text));
}
