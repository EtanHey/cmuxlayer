import { codexAccountSecurityBannerVariant, isCodexAccountSecurityBanner, parseScreen } from "../screen-parser.js";
import { appendDaemonLog } from "../daemon-log.js";
import type { EventLog } from "../event-log.js";
import { sleep } from "../util/sleep.js";
import { DeliverySafetyGateError } from "./receipts.js";

/** Esc only, once. A reread is required before any other input or readiness. */
export async function dismissAccountSecurityBanner<T extends { text: string }>(
  screen: T,
  io: { escape: () => Promise<void>; read: () => Promise<T> },
  audit?: { agent_id: string | null; surface: string; eventLog: Pick<EventLog, "appendAccountSecurityBanner"> },
): Promise<T> {
  const variant = codexAccountSecurityBannerVariant(screen.text);
  if (variant === null) return screen;
  let outcome: "dismissed" | "failed" = "failed";
  try {
    await io.escape();
    let observed = screen;
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(200);
      observed = await io.read();
      if (!isCodexAccountSecurityBanner(observed.text)) {
        outcome = "dismissed";
        return observed;
      }
    }
    throw new DeliverySafetyGateError("account_security_banner_not_dismissed", parseScreen(observed.text));
  } finally {
    if (audit) {
      const fields = { agent_id: audit.agent_id, surface: audit.surface, variant, outcome };
      appendDaemonLog("account_security_banner", fields);
      audit.eventLog.appendAccountSecurityBanner({ ts: new Date().toISOString(), event_type: "account_security_banner", ...fields });
    }
  }
}
