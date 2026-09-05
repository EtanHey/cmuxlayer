import { writeSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ratchet on type-escape hatches in production source.
 *
 * `src/` is the GATE: the count may shrink, never grow. Two sites are pinned by
 * path; a third site, or a site in any other file, goes red with the offending
 * `file:line` pairs listed so a regression is one-glance readable.
 *
 * `tests/` is a BURN-DOWN, not a gate. Its count is printed on the report line
 * and never asserted — test files legitimately reach for the escape hatch to
 * build partial doubles, and gating that would only push people to `@ts-expect-
 * error`. Tracking the number is the point; forcing it down is not this test's
 * job.
 *
 * Note on this file's own prose: the matcher below is whitespace-flexible, so
 * the phrase it hunts for is written hyphenated ("as-any") everywhere in these
 * comments. Spelling it out would make this file self-matching and quietly
 * inflate the burn-down number it reports.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

// Stated glob for the gate. Directory pruning and the generated-file exclusion
// below implement it; `src/` is currently flat and all-`.ts`, and the walk is
// recursive so nested directories are covered the day one appears.
const SOURCE_GLOB = "src/**/*.{ts,tsx} (excludes node_modules/, dist/, *.d.ts)";
const TESTS_GLOB =
  "tests/**/*.{ts,tsx} (excludes node_modules/, dist/, *.d.ts)";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SCAN_EXTENSIONS = [".ts", ".tsx"];
// tsc declaration output is generated, never hand-written; it must not count.
const GENERATED_SUFFIX = ".d.ts";

/** The ceiling. Lower it whenever a pinned site is removed; never raise it. */
const SRC_CEILING = 2;

/**
 * The two sites pinned by path (not by line — line numbers churn and a ratchet
 * that fails on unrelated edits gets deleted). Verified on main af5baa07:
 *   src/entry.ts   — `transport: transport as <escape>` at the MCP transport seam
 *   src/server.ts  — `(server as <escape>)._registeredTools["interact"]`
 */
const PINNED_SRC_PATHS: readonly string[] = ["src/entry.ts", "src/server.ts"];

/**
 * TypeScript treats whitespace and comments alike as trivia, so every one of
 * these compiles and every one of them is a real escape hatch:
 *
 *   x AS ANY            x AS <slash-star c star-slash> ANY
 *   x AS  (newline) ANY x AS <slash-slash c> (newline) ANY
 *
 * The separator group therefore accepts a whitespace character, a block
 * comment, or a line comment, repeated. Each alternative is a SINGLE unit
 * (`\s`, not `\s+`) with the `+` on the outside: that leaves exactly one way to
 * match a run of whitespace, so the nested quantifiers cannot backtrack
 * exponentially on a near-miss. This test reads every file in the repo, so a
 * ReDoS here would be a self-inflicted hang.
 *
 * The trailing word boundary keeps lookalike suffixes (`...thing`, `...Of`)
 * from matching. The `[a]ny` character class stops this file matching itself.
 */
const ESCAPE_HATCH =
  /\bas(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))+[a]ny\b/g;

/**
 * The two keywords, kept apart so fixtures can join them with whatever
 * separator a case needs. Spelling the pair out literally anywhere in this file
 * would make it self-matching and inflate the burn-down number it reports.
 */
const AS = "as";
const ANY = "any";
const HATCH = `${AS} ${ANY}`;

type Site = { path: string; line: number };

// Async on purpose. The sync form blocks the vitest worker's event loop for the
// whole walk-and-read of src/ + tests/ (server.ts alone is ~19k lines), which
// starves the worker's `onTaskUpdate` RPC heartbeat and fails the run with
// `[vitest-worker]: Timeout calling "onTaskUpdate"` while every test passes.
// Awaiting per file yields often enough for the heartbeat to get through.
async function scannableFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        files.push(...(await scannableFiles(absolutePath)));
      }
      continue;
    }
    if (entry.name.endsWith(GENERATED_SUFFIX)) continue;
    if (SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(absolutePath);
    }
  }

  return files;
}

/**
 * Every occurrence, not every line: two casts on one line count as two.
 *
 * Matches against the WHOLE source rather than line by line. Splitting first
 * would hide any cast whose separator contains a newline — a line-wrapped cast
 * or one broken by a line comment — which is the same class of miss the
 * separator group above exists to close.
 *
 * Line numbers come from a single forward walk over the source (matchAll yields
 * matches in ascending index order), so this stays linear in file length rather
 * than re-slicing the file once per match. A multi-line match reports the line
 * its `as` starts on.
 */
function sitesIn(source: string, path: string): Site[] {
  const sites: Site[] = [];
  let cursor = 0;
  let line = 1;

  for (const match of source.matchAll(ESCAPE_HATCH)) {
    const index = match.index ?? 0;
    for (; cursor < index; cursor += 1) {
      if (source[cursor] === "\n") line += 1;
    }
    sites.push({ path, line });
  }

  return sites;
}

async function scanDirectory(directoryName: string): Promise<Site[]> {
  const files = await scannableFiles(join(REPO_ROOT, directoryName));
  const sites: Site[] = [];

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, "utf8");
    sites.push(
      ...sitesIn(content, relative(REPO_ROOT, absolutePath).split(sep).join("/")),
    );
  }

  return sites;
}

function render(sites: Site[]): string {
  return sites.map((site) => `  ${site.path}:${site.line}`).join("\n");
}

/**
 * Throws with the full offender list when the ratchet slips. Pure over `sites`
 * so the red path is provable from a fixture as well as from real source.
 */
function assertSrcRatchet(sites: Site[]): void {
  const unpinned = sites.filter(
    (site) => !PINNED_SRC_PATHS.includes(site.path),
  );

  if (sites.length > SRC_CEILING) {
    throw new Error(
      `as-any ratchet slipped: ${SOURCE_GLOB} has ${sites.length} ` +
        `occurrences, ceiling is ${SRC_CEILING}.\n${render(sites)}\n` +
        `Remove the new one, or lower the ceiling only if you removed a pinned site.`,
    );
  }

  if (unpinned.length > 0) {
    throw new Error(
      `as-any ratchet slipped: ${unpinned.length} occurrence(s) outside the ` +
        `pinned sites [${PINNED_SRC_PATHS.join(", ")}].\n${render(unpinned)}\n` +
        `The ratchet pins by path; a new file may not acquire one.`,
    );
  }
}

describe("as-any ratchet", () => {
  it("holds src at or below the pinned ceiling", async () => {
    const sites = await scanDirectory("src");

    assertSrcRatchet(sites);

    expect(sites.length).toBeLessThanOrEqual(SRC_CEILING);
    // Subset, not equality: removing a pinned site must stay green.
    for (const site of sites) {
      expect(PINNED_SRC_PATHS).toContain(site.path);
    }
  });

  it("reports the tests burn-down without gating it", async () => {
    const sites = await scanDirectory("tests");

    // Not an assertion on the value: this number is tracked, never enforced.
    //
    // Written straight to fd 1 rather than through `console`. Vitest intercepts
    // worker console output and ships it to the main thread over the same
    // `onTaskUpdate` RPC that carries task results; on a loaded machine that
    // round-trip times out and fails the whole run with
    // `[vitest-worker]: Timeout calling "onTaskUpdate"` while all tests pass.
    // This is the only test in the suite that prints, so it was the only one
    // paying that cost. `writeSync` bypasses the interception and still lands
    // on the report line.
    writeSync(1, `as-any burn-down: tests=${sites.length}\n`);

    // The only guard here is that the scanner still works. A silent 0 would
    // mean the walk broke, not that the burn-down finished.
    expect(sites.length).toBeGreaterThan(0);
    expect(TESTS_GLOB).toContain("tests/**");
  });

  it("goes red when a third site appears", () => {
    const pinned: Site[] = [
      { path: "src/entry.ts", line: 430 },
      { path: "src/server.ts", line: 18853 },
    ];

    expect(() =>
      assertSrcRatchet([...pinned, { path: "src/entry.ts", line: 431 }]),
    ).toThrow(/has 3 occurrences, ceiling is 2/);
  });

  it("goes red when an unpinned file acquires one", () => {
    expect(() =>
      assertSrcRatchet([
        { path: "src/entry.ts", line: 430 },
        { path: "src/daemon.ts", line: 12 },
      ]),
    ).toThrow(/outside the pinned sites/);
  });

  it("counts occurrences rather than lines", () => {
    const doubled = `const a = x ${HATCH}, b = y ${HATCH};\n`;

    expect(sitesIn(doubled, "fixtures/double.ts")).toEqual([
      { path: "fixtures/double.ts", line: 1 },
      { path: "fixtures/double.ts", line: 1 },
    ]);
  });

  it("matches a cast split by a block comment", () => {
    const source = `const a = x ${AS} /* compatibility */ ${ANY};\n`;

    expect(sitesIn(source, "fixtures/block.ts")).toEqual([
      { path: "fixtures/block.ts", line: 1 },
    ]);
  });

  it("matches a cast split by a line comment", () => {
    const source = `const a = x ${AS} // why\n  ${ANY};\n`;

    expect(sitesIn(source, "fixtures/line.ts")).toEqual([
      { path: "fixtures/line.ts", line: 1 },
    ]);
  });

  it("matches a line-wrapped cast", () => {
    const source = `const a = x ${AS}\n  ${ANY};\n`;

    expect(sitesIn(source, "fixtures/wrapped.ts")).toEqual([
      { path: "fixtures/wrapped.ts", line: 1 },
    ]);
  });

  it("does not match lookalikes", () => {
    const lookalikes = `type T = A ${HATCH}thing; const u = v ${HATCH}Of;\n`;

    expect(sitesIn(lookalikes, "fixtures/lookalike.ts")).toEqual([]);
  });
});
