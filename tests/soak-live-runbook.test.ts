import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the soak script from a source checkout against the installed executable", () => {
  const runbook = readFileSync(new URL("../docs/testing/soak.md", import.meta.url), "utf8");
  const command = runbook.match(/node (scripts\/soak-live\.mjs) --agent-id/);
  expect(command).not.toBeNull();
  expect(existsSync(fileURLToPath(new URL(`../${command![1]}`, import.meta.url)))).toBe(true);
  expect(runbook).toMatch(/source checkout/i);
  expect(runbook).toMatch(/installed\s+`cmuxlayer` executable on `PATH`/i);
});
