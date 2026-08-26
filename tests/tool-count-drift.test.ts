import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const EXPECTED_TOOL_COUNT = 45;
const EXPECTED_DEFAULT_PALETTE_COUNT = 10;
// 45 is the callable-tool count; 10 is the ratified default-palette registry.
const EXPECTED_DOCUMENTED_COUNTS = new Set([
  EXPECTED_TOOL_COUNT,
  EXPECTED_DEFAULT_PALETTE_COUNT,
]);
const RUN_DRIFT_CHECK = process.env.CMUXLAYER_RUN_TOOL_COUNT_DRIFT === "1";

// The plan calls this registration source `registerTool(`. cmuxlayer's current
// MCP SDK integration spells the same operation `server.tool(`; support both
// spellings so the guard checks the live registration source while preserving
// the plan's intended seam.
const REGISTRATION_PATTERN =
  /\b(?:registerTool|server\.tool)\s*\(\s*["']([^"']+)["']/g;
const DOCUMENTED_COUNT_PATTERN =
  /\b(\d+)(?:[ -]|%20)(?:MCP )?tools?\b/gi;
// Known blind spot: "N registered" phrasing is intentionally not matched.

const EXCLUDED_DIRECTORY_PARTS = new Set(["site", "out", ".next"]);
const EXCLUDED_PATHS = new Set([
  "docs/design/track-4-send-to-wait-for-facade.md",
]);

type Document = { path: string; content: string };
type CountClaim = {
  path: string;
  line: number;
  count: number;
  expected: number;
  text: string;
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_PARTS.has(entry.name) || entry.name === ".next") {
        return [];
      }
      return sourceFiles(absolutePath);
    }
    return entry.name.endsWith(".ts") ? [absolutePath] : [];
  });
}

function registeredToolNames(root = join(REPO_ROOT, "src")): string[] {
  return sourceFiles(root).flatMap((filePath) => {
    const source = readFileSync(filePath, "utf8");
    return [...source.matchAll(REGISTRATION_PATTERN)].map((match) => match[1]);
  });
}

function documentedFiles(root = REPO_ROOT): Document[] {
  // GEMINI.md is an operator-local surface and is globally ignored in this
  // checkout; include it when present without making clean CI checkouts fail.
  const paths = ["README.md", "GEMINI.md"].filter((path) =>
    existsSync(join(root, path)),
  );
  const docsRoot = join(root, "docs");
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "out" || entry.name === ".next") return [];
        return walk(absolutePath);
      }
      return entry.name.endsWith(".md") ? [absolutePath] : [];
    });

  return [...paths.map((path) => join(root, path)), ...walk(docsRoot)]
    .map((absolutePath) => ({
      path: relative(root, absolutePath).split(sep).join("/"),
      content: readFileSync(absolutePath, "utf8"),
    }))
    .filter(({ path }) => !EXCLUDED_PATHS.has(path));
}

function claimsIn(documents: Document[]): CountClaim[] {
  return documents.flatMap(({ path, content }) => {
    const claims: CountClaim[] = [];
    for (const [lineIndex, line] of content.split("\n").entries()) {
      // before/after bullets are historical design measurements, not current
      // public claims. Dated release-note/changelog blocks follow the same rule.
      if (/^\s*-\s*(?:before|after):/i.test(line)) continue;
      for (const match of line.matchAll(DOCUMENTED_COUNT_PATTERN)) {
        const count = Number(match[1]);
        const isDefaultPaletteClaim =
          /default (?:MCP )?palette|thin-core default|palette/i.test(line) &&
          count === EXPECTED_DEFAULT_PALETTE_COUNT;
        claims.push({
          path,
          line: lineIndex + 1,
          count,
          expected: isDefaultPaletteClaim
            ? EXPECTED_DEFAULT_PALETTE_COUNT
            : EXPECTED_TOOL_COUNT,
          text: line.trim(),
        });
      }
    }
    return claims;
  });
}

function assertDocumentedCounts(documents: Document[], expected: number): void {
  const staleClaims = claimsIn(documents).filter(
    (claim) =>
      !EXPECTED_DOCUMENTED_COUNTS.has(claim.count) ||
      claim.count !== claim.expected,
  );
  if (staleClaims.length === 0) return;

  const details = staleClaims
    .map(
      (claim) =>
        `${claim.path}:${claim.line} documents ${claim.count}; source registers ${expected} (${claim.text})`,
    )
    .join("\n");
  throw new Error(`tool-count drift detected:\n${details}`);
}

describe("tool-count drift guard", () => {
  it.skipIf(!RUN_DRIFT_CHECK)(
    "keeps documented callable-tool counts equal to registrations",
    () => {
    const names = registeredToolNames();
    expect(names).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(new Set(names).size).toBe(EXPECTED_TOOL_COUNT);

    assertDocumentedCounts(documentedFiles(), names.length);
    },
  );

  it("goes red when a fixture count is mutated", () => {
    const fixture = "The server exposes 45 tools.\n";
    const mutatedFixture = fixture.replace("45", "44");

    expect(() =>
      assertDocumentedCounts(
        [{ path: "fixtures/tool-count.md", content: mutatedFixture }],
        EXPECTED_TOOL_COUNT,
      ),
    ).toThrow(
      "fixtures/tool-count.md:1 documents 44; source registers 45 (The server exposes 44 tools.)",
    );
  });

  it("recognizes URL-encoded badge counts", () => {
    expect(() =>
      assertDocumentedCounts(
        [{
          path: "fixtures/tool-count-badge.md",
          content: "badge/MCP-44%20tools-green.svg",
        }],
        EXPECTED_TOOL_COUNT,
      ),
    ).toThrow("fixtures/tool-count-badge.md:1 documents 44; source registers 45");
  });

  it("recognizes hyphenated singular tool counts", () => {
    expect(() =>
      assertDocumentedCounts(
        [{ path: "fixtures/tool-count-hyphen.md", content: "The server exposes 44-tool default.\n" }],
        EXPECTED_TOOL_COUNT,
      ),
    ).toThrow("fixtures/tool-count-hyphen.md:1 documents 44; source registers 45");
  });
});
