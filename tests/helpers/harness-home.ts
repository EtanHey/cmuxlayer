/**
 * Test seam for the session-artifact check (#482/#492).
 *
 * `resumable` is now an observation: it asks whether the harness transcript is
 * on disk. Tests must therefore decide which sessions exist, without reading
 * the operator's real `~/.claude` or `~/.codex`. `useHarnessHome()` points the
 * check at a fresh throwaway home per test; `give()` puts a transcript in it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "vitest";
import type { CliType } from "../../src/agent-types.js";

export interface HarnessHome {
  /** Create the transcript that makes `sessionId` a resumable session. */
  give(cli: CliType, sessionId: string): void;
  path(): string;
}

export function useHarnessHome(): HarnessHome {
  let home = "";
  let previous: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cmux-harness-home-"));
    previous = process.env.CMUXLAYER_HARNESS_HOME;
    process.env.CMUXLAYER_HARNESS_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CMUXLAYER_HARNESS_HOME;
    else process.env.CMUXLAYER_HARNESS_HOME = previous;
  });

  return {
    path: () => home,
    give(cli, sessionId) {
      const write = (dir: string, file: string): void => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, file), `{"session_id":"${sessionId}"}\n`);
      };
      switch (cli) {
        case "claude":
          write(
            join(home, ".claude", "projects", "-tmp-repo"),
            `${sessionId}.jsonl`,
          );
          return;
        case "cursor":
          write(
            join(
              home,
              ".cursor",
              "projects",
              "-tmp-repo",
              "agent-transcripts",
              sessionId,
            ),
            `${sessionId}.jsonl`,
          );
          return;
        case "codex":
          write(
            join(home, ".codex", "sessions", "2026", "08", "19"),
            `rollout-2026-08-19T03-40-00-${sessionId}.jsonl`,
          );
          return;
        default:
          throw new Error(`${cli} has no transcript store to seed`);
      }
    },
  };
}
