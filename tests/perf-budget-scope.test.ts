import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The daemon performance budget benchmarks a live daemon on a shared runner, so
 * its p95 rows carry real variance. Backlog #452: on cmuxlayer#595 — a diff of
 * one test file, no `src/` — it failed twice on two DIFFERENT metrics
 * (`send_to_surface_warm` p95 99.72ms vs 89ms, then `send_to_agent_warm` p95
 * 193.07ms vs 181.25ms) after passing on an earlier head of the same diff.
 *
 * This guards the scoping fix: strict where the diff could move a timing,
 * warn-and-skip where it provably cannot.
 */

const workflow = readFileSync(
  join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
  "utf8",
);

const perfBudgetJob = workflow.slice(
  workflow.indexOf("  perf-budget:"),
  workflow.indexOf("  test:"),
);

/**
 * The prefix list is read out of the workflow rather than duplicated here, so
 * editing the workflow's list re-points these cases instead of silently
 * drifting from them.
 */
function performanceRelevantPrefixes(): string[] {
  const block = perfBudgetJob.match(
    /const PERF_RELEVANT = \[([\s\S]*?)\];/,
  )?.[1];
  if (!block) throw new Error("PERF_RELEVANT list not found in ci.yml");
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** The workflow's own predicate, kept to one line so it cannot drift in spirit. */
function wouldRunBudget(changedFiles: string[]): boolean {
  const prefixes = performanceRelevantPrefixes();
  return changedFiles.some((name) =>
    prefixes.some((prefix) => name.startsWith(prefix)),
  );
}

describe("perf-budget scoping (backlog #452)", () => {
  it("gates the benchmark on the scope step rather than always running it", () => {
    expect(perfBudgetJob).toContain("id: scope");
    expect(perfBudgetJob).toMatch(
      /- name: Run daemon performance budget\n\s+if: steps\.scope\.outputs\.run == 'true'/,
    );
  });

  it("reports a skip instead of falling through to the comment step's ERROR", () => {
    expect(perfBudgetJob).toMatch(
      /- name: Report skipped performance budget\n\s+if: steps\.scope\.outputs\.run != 'true'/,
    );
    expect(perfBudgetJob).toContain("Daemon performance budget: SKIPPED");
  });

  it("never records green-main history from a skipped run", () => {
    expect(perfBudgetJob).toMatch(
      /- name: Save bounded green-main benchmark history\n\s+if: success\(\) && steps\.scope\.outputs\.run == 'true'/,
    );
  });

  it("scopes with a step, not a workflow-level paths filter", () => {
    // ci.yml carries seven jobs; `on.pull_request.paths` would gate all of them,
    // because GitHub has no per-job paths filter.
    const triggers = workflow.slice(0, workflow.indexOf("permissions:"));
    expect(triggers).not.toMatch(/^\s+paths(-ignore)?:/m);
  });

  it("skips a diff that cannot move a daemon timing", () => {
    // The literal cmuxlayer#595 file list that failed twice on jitter.
    expect(wouldRunBudget(["tests/no-new-as-any.test.ts"])).toBe(false);
    expect(wouldRunBudget(["README.md", "docs/design/foo.md"])).toBe(false);
  });

  it("stays strict on anything that can move a daemon timing", () => {
    for (const changed of [
      ["src/daemon.ts"],
      ["src/server.ts", "tests/agent-engine.test.ts"],
      ["benchmarks/daemon-baseline.json"],
      ["scripts/bench-daemon.mjs"],
      ["scripts/check-daemon-benchmark.mjs"],
      ["package.json"],
      ["bun.lock"],
      [".github/workflows/ci.yml"],
    ]) {
      expect(
        wouldRunBudget(changed),
        `should run for ${changed.join(", ")}`,
      ).toBe(true);
    }
  });

  it("covers the baseline and harness, not just src/", () => {
    // Skipping a baseline edit would let a budget change land unmeasured —
    // the one regression this guard must not introduce.
    const prefixes = performanceRelevantPrefixes();
    expect(prefixes).toContain("src/");
    expect(prefixes).toContain("benchmarks/");
    expect(prefixes.some((prefix) => prefix.startsWith("scripts/"))).toBe(true);
  });
});
