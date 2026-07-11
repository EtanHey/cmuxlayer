// The release script bumps package.json before its pre-push Vitest rerun.
// Keep unit tests from comparing that temporary version with the host brew tree.
process.env.CMUXLAYER_DEV = "1";
