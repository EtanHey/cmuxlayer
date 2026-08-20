import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * One temp root per suite RUN, removed when the run ends.
 *
 * See tests/vitest.setup.ts for why. Isolating per run — not per worker — is
 * exactly right: within a run vitest never executes one test file twice at once,
 * so the fixed fixture names only collide ACROSS runs.
 */
const root = join("/tmp", `cmuxlayer-vitest-${process.pid}`);

export function setup(): void {
  mkdirSync(root, { recursive: true });
  process.env.CMUXLAYER_TEST_TMP_ROOT = root;
}

export function teardown(): void {
  rmSync(root, { recursive: true, force: true });
}
