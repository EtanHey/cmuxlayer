import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deterministic guard for the cmux vs cmuxlayer naming distinction.
 *
 *   - `cmux`      = the terminal app / terminal CLI / terminal surfaces
 *                   (a separate product: github.com/manaflow-ai/cmux).
 *   - `cmuxlayer` = THIS repo — the MCP server / managed-agent / orchestration
 *                   layer that sits on top of cmux.
 *
 * The repo's own voice (source, docs, README, CLAUDE.md) must call the layer
 * `cmuxlayer`, never `cmux MCP` / `cmux-mcp` / `cmux.layer` / `cmux layer`.
 * Legitimate references to the cmux terminal app, the `cmux` CLI binary, the
 * cmux socket, or the `CMUX_SOCKET_PATH` env var are NOT matched by these
 * patterns and stay as-is.
 *
 * Test fixtures under tests/ that simulate *agent* prose (an agent loosely
 * saying "the cmux MCP transport closed") are intentionally out of scope —
 * that is third-party voice, not the repo describing itself.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Each pattern collapses the cmux/cmuxlayer distinction when it appears in the
// repo's own voice. Note: "cmuxlayer" never matches — there is no separator
// between "cmux" and the following token, which every pattern requires.
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  {
    re: /cmux[ ._-]mcp/i,
    why: 'use "cmuxlayer" (the layer), not "cmux MCP"/"cmux-mcp"',
  },
  {
    re: /cmux[ .]layer/i,
    why: 'the layer is one word: "cmuxlayer", not "cmux layer"/"cmux.layer"',
  },
  { re: /cmuxMcp/, why: 'use a cmuxlayer-based identifier, not "cmuxMcp"' },
];

const SCAN_EXT = new Set([".ts", ".md"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "tests",
  "fixtures",
]);

function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectFiles(full, out);
    } else if (SCAN_EXT.has(entry.slice(entry.lastIndexOf(".")))) {
      out.push(full);
    }
  }
}

function ownVoiceFiles(): string[] {
  const out: string[] = [];
  collectFiles(join(repoRoot, "src"), out);
  if (existsSync(join(repoRoot, "docs")))
    collectFiles(join(repoRoot, "docs"), out);
  for (const top of ["README.md", "CLAUDE.md"]) {
    const full = join(repoRoot, top);
    if (existsSync(full)) out.push(full);
  }
  return out;
}

describe("cmux vs cmuxlayer naming convention", () => {
  it("the repo's own voice never collapses the distinction", () => {
    const offenders: string[] = [];
    for (const file of ownVoiceFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const { re, why } of FORBIDDEN) {
          if (re.test(line)) {
            offenders.push(
              `${relative(repoRoot, file)}:${i + 1}  ${line.trim()}\n      -> ${why}`,
            );
          }
        }
      });
    }
    expect(
      offenders,
      `Found references that confuse the cmux terminal app with the cmuxlayer MCP layer:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("scans a non-trivial number of own-voice files (guard is actually wired up)", () => {
    expect(ownVoiceFiles().length).toBeGreaterThan(5);
  });
});
