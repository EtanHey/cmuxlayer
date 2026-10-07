import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 0.65.0 AppCatalogSection userDefaultsKey values, not settings catalog IDs.
export const closePreferenceKeys = ["warnBeforeClosingWorkspace", "warnBeforeClosingTabShortcut"];
// NO is a string in NSArgumentDomain and is rejected by cmux's Bool decoder.
const booleanFalse = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><false/></plist>';
export const closePreferenceArgs = () => closePreferenceKeys.flatMap(key => [`-${key}`, booleanFalse]);
export function verifyClosePreferences(exec = execFileSync) {
  const source = fileURLToPath(new URL("./close-preferences.swift", import.meta.url));
  const result = JSON.parse(exec("/usr/bin/swift", [source, ...closePreferenceArgs()], { encoding: "utf8", timeout: 30_000 }));
  if (result.status !== "PASS" || result.domain !== "NSArgumentDomain" ||
      result.typed_boolean_false !== true || result.persistent_domain_unchanged !== true) throw new Error("volatile close preferences unverified");
  return result;
}
