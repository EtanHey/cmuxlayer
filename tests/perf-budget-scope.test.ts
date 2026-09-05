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
 *
 * The behavioural cases below run the workflow's OWN `github-script` body,
 * extracted from ci.yml, rather than a copy of its logic. JS embedded in YAML
 * is invisible to `tsc`, so executing the real thing is the only way these
 * assertions cannot drift from what CI actually does.
 */

const workflow = readFileSync(
  join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
  "utf8",
);

const perfBudgetJob = workflow.slice(
  workflow.indexOf("  perf-budget:"),
  workflow.indexOf("  test:"),
);

/** Pull the `script: |` body of the scope step out of the YAML, de-indented. */
function scopeScriptSource(): string {
  const afterStep = perfBudgetJob.split(
    "- name: Decide whether the benchmark must run",
  )[1];
  if (afterStep === undefined)
    throw new Error("scope step not found in ci.yml");

  const body = afterStep.split("script: |")[1];
  if (body === undefined) throw new Error("scope step has no script block");

  const indent = " ".repeat(12);
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      lines.push("");
      continue;
    }
    if (!line.startsWith(indent)) break;
    lines.push(line.slice(indent.length));
  }
  return lines.join("\n");
}

type Decision = { run?: string; reason?: string; warned?: string };
type ChangedFile = { filename: string; previous_filename?: string };

/** Run the real script against a synthetic event and capture its outputs. */
async function decide(
  eventName: string,
  files: ChangedFile[],
): Promise<Decision> {
  const decision: Decision = {};
  const core = {
    setOutput(name: string, value: string) {
      if (name === "run") decision.run = value;
      if (name === "reason") decision.reason = value;
    },
    warning(message: string) {
      decision.warned = message;
    },
  };
  const github = {
    // Promise-returning rather than `async`: the workflow script awaits this,
    // but an `async` function with no `await` inside trips DeepSource JS-0116.
    paginate: () => Promise.resolve(files),
    rest: { pulls: { listFiles: null } },
  };
  const context = {
    eventName,
    repo: { owner: "EtanHey", repo: "cmuxlayer" },
    issue: { number: 596 },
  };

  const run = new Function(
    "context",
    "github",
    "core",
    `return (async () => {\n${scopeScriptSource()}\n})();`,
  );
  await run(context, github, core);
  return decision;
}

const named = (...names: string[]): ChangedFile[] =>
  names.map((filename) => ({ filename }));

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

  it("skips a diff that cannot move a daemon timing", async () => {
    // The literal cmuxlayer#595 file list that failed twice on jitter.
    const jitterPr = await decide(
      "pull_request",
      named("tests/no-new-as-any.test.ts"),
    );
    expect(jitterPr.run).toBe("false");
    expect(jitterPr.warned).toBeDefined();

    const docsPr = await decide(
      "pull_request",
      named("README.md", "docs/design/foo.md"),
    );
    expect(docsPr.run).toBe("false");
  });

  it("stays strict on anything that can move a daemon timing", async () => {
    for (const changed of [
      ["src/daemon.ts"],
      ["src/server.ts", "tests/agent-engine.test.ts"],
      ["benchmarks/daemon-baseline.json"],
      ["scripts/bench-daemon.mjs"],
      ["scripts/check-daemon-benchmark.mjs"],
      ["package.json"],
      ["bun.lock"],
      [".github/workflows/ci.yml"],
      // bench:daemon:check runs `bun run build` (tsc -p tsconfig.json) and
      // benchmarks dist/daemon.js, so compiler settings decide what is measured.
      ["tsconfig.json"],
      ["tsconfig.build.json"],
    ]) {
      const decision = await decide("pull_request", named(...changed));
      expect(decision.run, `should run for ${changed.join(", ")}`).toBe("true");
    }
  });

  it("runs on a non-PR event so main keeps a complete green-main history", async () => {
    const decision = await decide("push", []);
    expect(decision.run).toBe("true");
  });

  it("catches a rename that moves daemon code out of a scoped path", async () => {
    // The new name matches nothing, but daemon code still changed. GitHub
    // exposes the pre-rename path as previous_filename.
    const decision = await decide("pull_request", [
      { filename: "lib/daemon.ts", previous_filename: "src/daemon.ts" },
    ]);
    expect(decision.run).toBe("true");
  });

  it("runs rather than guesses when the diff hits the listFiles cap", async () => {
    // pulls.listFiles caps at 3000 entries, so a src/ change can sit past it.
    const capped = Array.from({ length: 3000 }, (_, index) => ({
      filename: `docs/page-${index}.md`,
    }));
    const decision = await decide("pull_request", capped);
    expect(decision.run).toBe("true");
    expect(decision.reason).toContain("3000");
  });

  it("still skips a large-but-under-cap irrelevant diff", async () => {
    const under = Array.from({ length: 2999 }, (_, index) => ({
      filename: `docs/page-${index}.md`,
    }));
    const decision = await decide("pull_request", under);
    expect(decision.run).toBe("false");
  });
});
