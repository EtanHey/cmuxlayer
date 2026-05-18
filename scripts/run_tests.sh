#!/usr/bin/env bash
set -u

EXIT_STATUS=0
FIXTURE_PATH="$(pwd)/tests/fixtures/race_condition_screen.vt"
EXPECTED_RENDER="| Waveform: [|=--]"
export FIXTURE_PATH
export EXPECTED_RENDER

node --input-type=module - <<'NODE'
import { readFileSync } from "node:fs";
import TransformTTY from "transform-tty";

const fixturePath = process.env.FIXTURE_PATH;
const expected = process.env.EXPECTED_RENDER ?? "";

try {
  const raw = readFileSync(fixturePath, "utf8");
  const terminal = new TransformTTY({ rows: 8, columns: 120 });
  terminal.write(raw);
  const rendered = terminal.toString();

  if (rendered !== expected) {
    console.error(`Unexpected render result:\n${JSON.stringify(rendered)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE

if [ $? -ne 0 ]; then
  ((EXIT_STATUS |= 1))
fi

if ! bun test tests/race-condition-vt-fixture.test.ts; then
  ((EXIT_STATUS |= 2))
fi

if ! bun test ./tests/regression/test_terminal_state.ts; then
  ((EXIT_STATUS |= 8))
fi

if ! bun run test; then
  ((EXIT_STATUS |= 4))
fi

echo "run_tests.sh finished with exit status $EXIT_STATUS"

if [ "$EXIT_STATUS" -ne 0 ]; then
  exit "$EXIT_STATUS"
fi
