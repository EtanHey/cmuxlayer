import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("live ratchet fail-closed CLI", () => {
  it("writes FAIL receipts and exits 1 when NIGHTLY is missing", () => {
    const out = join(mkdtempSync(join(tmpdir(), "ratchet-red-")), "receipt.json");
    const result = spawnSync(process.execPath, ["scripts/ratchet-live.mjs", "--capability",
      "--app", "/nonexistent/cmux NIGHTLY.app", "--output", out], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("| FAIL |");
    expect(result.stdout).not.toContain("SKIP");
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ status: "FAIL" });
  });
});
