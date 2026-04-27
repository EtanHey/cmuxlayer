import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import TransformTTY from "transform-tty";

const fixturePath = join(process.cwd(), "tests", "fixtures", "race_condition_screen.vt");
const baselinePath = join(
  process.cwd(),
  "tests",
  "regression",
  "race-condition.baseline.txt",
);

function renderFixture(raw: string): string {
  const terminal = new TransformTTY({
    rows: 8,
    columns: 120,
  });

  terminal.write(raw);

  return terminal.toString();
}

describe("terminal state regression", () => {
  it("replays race_condition_screen.vt deterministically against baseline", () => {
    const rawFixture = readFileSync(fixturePath, "utf8");
    const baseline = readFileSync(baselinePath, "utf8");

    const rendered = renderFixture(rawFixture);

    expect(Buffer.from(rendered)).toEqual(Buffer.from(baseline));
  });
});
