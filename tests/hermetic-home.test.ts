import { describe, expect, it } from "vitest";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { loadFleetConfig } from "../src/fleet-config.js";

// #834: a unit test must never write into the operator's real home. On a fleet
// Mac that is the LIVE coordination dir (~/.golems-zikaron, ~/.local/state/…).
// tests/vitest.setup.ts points HOME at the run's temp root, so every default
// that derives from homedir() lands in the sandbox.
describe("hermetic HOME (#834)", () => {
  const runRoot = process.env.TMPDIR ?? "";

  it("runs every test with HOME inside the run's temp root, not the real home", () => {
    expect(runRoot).not.toBe("");
    expect(homedir()).toBe(join(runRoot, "home"));
    expect(homedir()).not.toBe(userInfo().homedir);
  });

  it("resolves home-derived defaults into the sandbox", () => {
    expect(
      loadFleetConfig({}).coordinationDir.startsWith(join(runRoot, "home")),
    ).toBe(true);
  });
});
