import { expect, it } from "vitest";
import { closePreferenceArgs, verifyClosePreferences } from "../scripts/xmac/close-preferences.mjs";
it("uses typed volatile values and refuses an unverified runtime preflight", () => {
  const args = closePreferenceArgs();
  expect(args[0]).toBe("-warnBeforeClosingWorkspace");
  expect(args[2]).toBe("-warnBeforeClosingTabShortcut");
  expect(args[1]).toContain("<false/>");
  expect(() => verifyClosePreferences(() => JSON.stringify({ status: "PASS", domain: "persistent" }))).toThrow("unverified");
});
