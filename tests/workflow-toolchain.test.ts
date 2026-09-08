import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");
const workflowDir = join(repoRoot, ".github", "workflows");

interface Job {
  label: string;
  source: string;
}

/** Every job, across every workflow, that runs the cmuxlayer test suite. */
function suiteJobs(): Job[] {
  const jobs: Job[] = [];

  for (const file of readdirSync(workflowDir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const lines = readFileSync(join(workflowDir, file), "utf8").split("\n");

    let name: string | null = null;
    let body: string[] = [];
    const flush = () => {
      if (name) jobs.push({ label: `${file}:${name}`, source: body.join("\n") });
      name = null;
      body = [];
    };

    for (const line of lines) {
      const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (header) {
        flush();
        name = header[1];
        continue;
      }
      if (name) body.push(line);
    }
    flush();
  }

  // Match the job BODY, not the `run:` line: `run: |` with the invocation on the
  // next line is the ordinary Actions idiom, and a filter anchored to `run:`
  // walks straight past it — along with composite and reusable workflows.
  return jobs.filter(({ source }) => /\b(npm|bun) (run )?test\b/.test(source));
}

/**
 * AIDEV-NOTE: publish.yml ran the suite on setup-node alone for 105 releases.
 * The suite spawns `bun` (tests/fleet-sidebar.test.ts) and release.sh shells out
 * to `bun run`, so a bun-less runner fails on missing toolchain rather than on
 * anything about the code. Nobody read the log, so cmuxlayer never reached npm.
 *
 * publish.yml was deleted 2026-09-08 (#490: Etan ruled cmuxlayer is not
 * published to npm; Homebrew builds from the tag tarball and never reads the
 * registry). The specimen below moved to ci.yml:test, but the assertion is NOT
 * cosmetic and must not be dropped: it is the anti-vacuity guard for the test
 * beneath it. If `suiteJobs()` ever matches nothing -- a renamed workflow, a
 * changed invocation -- "every suite-running job installs bun" passes over an
 * empty list and proves nothing. Keep at least one known-good label asserted.
 */
describe("workflow toolchain matches what the suite spawns", () => {
  it("finds the jobs that run the suite", () => {
    const labels = suiteJobs().map((job) => job.label);
    expect(labels).toContain("ci.yml:test");
    expect(labels.length).toBeGreaterThan(0);
  });

  it("gives every suite-running job the bun the tests spawn", () => {
    for (const { label, source } of suiteJobs()) {
      expect(source, `${label} runs the suite without installing bun`).toContain(
        "oven-sh/setup-bun",
      );
    }
  });

  it("never runs the suite on a node older than package.json engines", () => {
    const engines: string = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ).engines.node;
    const minimumMajor = Number(engines.replace(/[^0-9.]/g, "").split(".")[0]);

    for (const { label, source } of suiteJobs()) {
      for (const [, version] of source.matchAll(/node-version:\s*'?"?(\d+)/g)) {
        expect(
          Number(version),
          `${label} pins node ${version} but engines require ${engines}`,
        ).toBeGreaterThanOrEqual(minimumMajor);
      }
    }
  });
});
