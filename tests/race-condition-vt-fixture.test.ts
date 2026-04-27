import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import TransformTTY from "transform-tty";

import { parseScreen } from "../src/screen-parser.js";

const RACE_FIXTURE_PATH = join(
  process.cwd(),
  "tests",
  "fixtures",
  "race_condition_screen.vt",
);

function extractAnsiSequences(input: string): string[] {
  const ANSIRE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
  return input.match(ANSIRE) ?? [];
}

function renderVtFixture(raw: string): string {
  const terminal = new TransformTTY({ rows: 8, columns: 120 });
  terminal.write(raw);
  return terminal.toString();
}

describe("race_condition_screen.vt", () => {
  it("replays known-bad send_input/send_key race stream deterministically", () => {
    const raw = readFileSync(RACE_FIXTURE_PATH, "utf8");
    const rendered = renderVtFixture(raw);

    expect(extractAnsiSequences(raw)).toEqual([
      "\x1B[2J",
      "\x1B[H",
      "\x1B[?25l",
      "\x1B[K",
      "\x1B[K",
      "\x1B[K",
      "\x1B[K",
      "\x1B[K",
    ]);

    expect(rendered).toBe("| Waveform: [|=--]");

    // Parse the cleaned output like a live screen read to ensure downstream parser still
    // infers deterministic agent state from the replayed stream.
    const parsed = parseScreen(rendered);
    expect(parsed.agent_type).toBe("unknown");
  });
});
