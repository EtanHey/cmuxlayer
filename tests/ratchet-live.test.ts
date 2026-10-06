import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The runner's plain-JS helper has no declaration file.
import { productionSnapshot, productionChanges, privateWrites } from "../scripts/ratchet-production-guard.mjs";

describe("production attribution guard", () => {
  const token = "RATCHET_SYNTHETIC_UNIQUE_RUN";
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), "ratchet-guard-"));
    for (const dir of [".local/state/cmuxlayer", ".local/state/cmux", ".cmuxlayer/tickets", ".cmux/agents"]) mkdirSync(join(home, dir), { recursive: true });
    const log = join(home, ".local/state/cmuxlayer/daemon.log");
    writeFileSync(log, token + "\n");
    return { home, log };
  }
  it("allows unrelated live writes and excludes pre-existing token bytes", () => {
    const { home, log } = fixture();
    writeFileSync(join(home, ".local/state/cmux/nightly-last-socket-path"), "/tmp/cmux-nightly.sock");
    const before = productionSnapshot(home);
    appendFileSync(log, "unrelated production append\n");
    writeFileSync(join(home, ".local/state/cmux/last-socket-path"), "/unrelated.sock");
    expect(productionChanges(before, productionSnapshot(home), [token], [])).toEqual([]);
  });
  it("requires a private daemon write and fails closed on lost appended ranges", () => {
    const { home, log } = fixture(), before = productionSnapshot(home);
    expect(privateWrites(home).status).toBe("PASS");
    writeFileSync(log, ""); expect(privateWrites(home).status).toBe("FAIL");
    expect(() => productionChanges(before, productionSnapshot(home), [token], [])).toThrow("truncated");
    renameSync(log, join(home, "outside.log"));
    expect(() => productionChanges(before, productionSnapshot(home), [token], [])).toThrow("disappeared");
  });
  it("attributes new agents and changed pointers to this run", () => {
    const { home } = fixture(), before = productionSnapshot(home);
    mkdirSync(join(home, ".cmux/agents/returned-agent"));
    mkdirSync(join(home, ".cmux/agents/ratchet-synthetic"));
    writeFileSync(join(home, ".local/state/cmux/nightly-last-socket-path"), "/tmp/cmux-nightly.sock");
    const changed = productionChanges(before, productionSnapshot(home), [token], ["returned-agent"]);
    expect(changed).toContain(".cmux/agents/returned-agent");
    expect(changed).toContain(".cmux/agents/ratchet-synthetic");
    expect(changed).toContain(".local/state/cmux/nightly-last-socket-path");
  });
  it("finds tokens across read chunks and in new/rotated logs and tickets", () => {
    const { home, log } = fixture(), before = productionSnapshot(home);
    appendFileSync(log, "x".repeat(65530) + token);
    writeFileSync(join(home, ".cmuxlayer/tickets/new.json"), JSON.stringify({ token }));
    writeFileSync(join(home, ".local/state/cmux/cmuxlayer-daemon-fixture.log"), token);
    let changed = productionChanges(before, productionSnapshot(home), [token], []);
    expect(changed).toContain(".local/state/cmuxlayer/daemon.log");
    expect(changed).toContain(".cmuxlayer/tickets/new.json");
    expect(changed).toContain(".local/state/cmux/cmuxlayer-daemon-fixture.log");
    const rotation = productionSnapshot(home);
    renameSync(log, log + ".1"); writeFileSync(log, token);
    changed = productionChanges(rotation, productionSnapshot(home), [token], []);
    expect(changed).toEqual([".local/state/cmuxlayer/daemon.log"]);
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
