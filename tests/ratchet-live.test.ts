import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The runner's plain-JS helper has no declaration file.
import { productionSnapshot, productionChanges } from "../scripts/ratchet-production-guard.mjs";

describe("production metadata guard", () => {
  it("detects same-size edits, additions, removals and agent listing changes", () => {
    const home = mkdtempSync(join(tmpdir(), "ratchet-guard-"));
    const paths = [".local/state/cmuxlayer/daemon.log", ".local/state/cmux/last-socket-path",
      ".local/state/cmux/nightly-last-socket-path", ".cmuxlayer/tickets/test.json", ".cmuxterm/events.jsonl"];
    for (const path of paths) {
      mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), "a");
    }
    mkdirSync(join(home, ".cmux/agents"), { recursive: true });
    const before = productionSnapshot(home);
    expect(productionChanges(before, productionSnapshot(home))).toEqual([]);
    for (const path of paths) { writeFileSync(join(home, path), "b"); utimesSync(join(home, path), 1, 1); }
    mkdirSync(join(home, ".cmux/agents/new-worker"));
    expect(productionChanges(before, productionSnapshot(home))).toEqual([...paths.sort(), ".cmux/agents listing"]);
    const edited = productionSnapshot(home);
    unlinkSync(join(home, paths[0])); writeFileSync(join(home, ".cmuxlayer/tickets/new.json"), "b");
    expect(productionChanges(edited, productionSnapshot(home))).toContain(paths[0]);
    expect(productionChanges(edited, productionSnapshot(home))).toContain(".cmuxlayer/tickets/new.json");
  });
});

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
