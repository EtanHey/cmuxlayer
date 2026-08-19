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
