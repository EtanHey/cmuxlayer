import { setResumeArtifactResolver } from "../src/resume-verification.js";

// The release script bumps package.json before its pre-push Vitest rerun.
// Keep unit tests from comparing that temporary version with the host brew tree.
process.env.CMUXLAYER_DEV = "1";

// #482: `resumable` is now an observation of the harness session store. The
// suite must never read the developer's real ~/.claude to decide it, so the
// default here is the honest "I did not look" answer — which is exactly the
// pre-#482 behaviour. Tests that exercise verification install their own
// resolver (see tests/resume-verification.test.ts).
setResumeArtifactResolver(() => "unverifiable");
