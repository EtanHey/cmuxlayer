import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reserveWatchReportPath } from "../src/watch-spec.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Before CX-2 U1a, watch-spec (and the since-retired monitor registry) wrote `<file>.tmp-<pid>-<ms>`
// and renamed it, with no cleanup: a failed rename left the temp file behind.
describe("registry writes leave no temp file behind on failure", () => {
  it("watch-spec report-path reservations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmuxlayer-orphan-"));
    dirs.push(dir);
    const registryPath = join(dir, "watch-specs.json");
    // Occupy the reservations file's path with a directory: the rename fails.
    mkdirSync(`${registryPath}.report-path-reservations.json`);

    await expect(
      reserveWatchReportPath(
        { owner: "lead-a", target: join(dir, "report.md") },
        { registryPath },
      ),
    ).rejects.toThrow();

    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

});
