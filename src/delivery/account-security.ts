import { codexDismissibleOverlayVariant, isCodexDismissibleOverlay, parseScreen } from "../screen-parser.js";
import { appendDaemonLog } from "../daemon-log.js";
import type { EventLog } from "../event-log.js";
import { sleep } from "../util/sleep.js";
import { DeliverySafetyGateError } from "./receipts.js";

/** Codex security/hooks setup: Esc only, once, then reread before other input. */
export async function dismissAccountSecurityBanner<T extends { text: string }>(
  screen: T,
  io: { escape: () => Promise<void>; read: () => Promise<T> },
  audit?: { agent_id: string | null; surface: string; eventLog: Pick<EventLog, "appendAccountSecurityBanner"> },
): Promise<T> {
  const variant = codexDismissibleOverlayVariant(screen.text);
  if (variant === null) return screen;
  let outcome: "dismissed" | "failed" = "failed";
  let observed = screen;
  try {
    await io.escape();
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(200);
      observed = await io.read();
      if (!isCodexDismissibleOverlay(observed.text)) {
        outcome = "dismissed";
        return observed;
      }
    }
    throw new DeliverySafetyGateError(variant === "hooks_review" ? "hooks_review_not_dismissed" : "account_security_banner_not_dismissed", parseScreen(observed.text));
  } catch (error) {
    if (variant === "hooks_review") throw new DeliverySafetyGateError("hooks_review_not_dismissed", parseScreen(observed.text));
    throw error;
  } finally {
    if (audit) {
      const fields = { agent_id: audit.agent_id, surface: audit.surface, variant, outcome };
      appendDaemonLog("account_security_banner", fields);
      audit.eventLog.appendAccountSecurityBanner({ ts: new Date().toISOString(), event_type: "account_security_banner", ...fields });
    }
  }
}
