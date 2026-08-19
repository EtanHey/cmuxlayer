import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The release script bumps package.json before its pre-push Vitest rerun.
// Keep unit tests from comparing that temporary version with the host brew tree.
process.env.CMUXLAYER_DEV = "1";

// AIDEV-NOTE: the seat registry (~/.golems/config.yaml) names the seats THIS
// operator runs. A test that reads it asserts against the host's fleet, so it
// passes on one Mac and fails everywhere else — which is exactly how a
// `brainClaude` assertion stayed green locally while CI was red for six days.
// Pin it at a path that cannot exist: tests state their own registry or get none.
process.env.CMUXLAYER_SEAT_REGISTRY_PATH = join(
  __dirname,
  "fixtures",
  "no-seat-registry-on-this-machine.yaml",
);

// AIDEV-NOTE: 63 test files build fixtures at a FIXED name under os.tmpdir()
// (`cmux-agents-test-engine`, `cmux-agents-test-registry`, …) and rmSync that
// path in afterEach. Two suite runs on one machine — two worktrees, or a fleet
// worker testing beside the maintainer — then share those directories and tear
// each other's down mid-test: ENOTEMPTY, plus assertions that quietly read
// another run's state. Measured on one file, run twice at once: 91 and 103
// failures without this, 0 and 0 with it. One temp root per RUN makes every one
// of those fixed names unique per run without touching 63 files.
//
// The root goes under /tmp, not under macOS's `/var/folders/…/T` default: unix
// socket paths cap at ~104 bytes and several suites bind sockets inside a temp
// dir, so a deeper root breaks them. /tmp/cmuxlayer-vitest-<pid> is HALF the
// length of the macOS default — this buys socket headroom rather than spending it.
// tests/global-setup.ts creates this root and removes it when the run ends.
const root =
  process.env.CMUXLAYER_TEST_TMP_ROOT?.trim() ||
  join("/tmp", `cmuxlayer-vitest-${process.ppid}`);
mkdirSync(root, { recursive: true });
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;
