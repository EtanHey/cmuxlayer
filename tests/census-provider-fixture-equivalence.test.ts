import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createKernelProcessProbe as acceptedProvider, type ProbeRunner } from "../src/kernel-process-probe.js";

const provenance = JSON.parse(readFileSync(new URL("./fixtures/census-provider-capture-provenance.json", import.meta.url), "utf8"));
const calls: unknown[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function createKernelProcessProbe(helper: string, runner: ProbeRunner) {
  return (uid: number) => acceptedProvider(helper, async (...args) => {
    const result = await runner(...args);
    calls.push({ args, result });
    return result;
  })(uid);
}
const identity = { pid: 42, ppid: 7, uid: 501, startSeconds: "123", startMicroseconds: "10", cwd: "/synthetic" };
async function healthy() {
  const stdout = JSON.stringify({ before: [42], after: [42], reason: null,
    processes: [{ ...identity, identityAfter: identity, sessionId: null, errors: [], failures: [] }],
    membershipReads: ["membership-before", "membership-after"].map(operation => ({ operation, queryBytes: 4, bytes: 4,
      capacityBytes: 1028, errno: 0, reason: null, observedPids: [42], membership: [42] })),
  });
  return createKernelProcessProbe("/synthetic", async () => ({ stdout, code: 0, failure: null, callbackSettled: true }))(501);
}

async function provider() {
  const payload = { before: null, after: [42], reason: "MEMBERSHIP_UNOBSERVED",
    processes: [{ ...identity, identityAfter: { ...identity, uid: "invalid" }, sessionId: null, errors: ["EPERM"],
      failures: [{ operation: "cwd-before", errno: 1, reason: "OBSERVED_ERRNO", bytes: 2352, expectedBytes: 2352, identity }] }],
    membershipReads: ["membership-before", "membership-after"].map(operation => ({ operation, queryBytes: 8, bytes: 8, capacityBytes: 1032,
      errno: 1, reason: "ENUMERATION_READ_INVALID", observedPids: [42, -7], membership: null })),
  };
  return createKernelProcessProbe("/synthetic", async () => ({ stdout: JSON.stringify(payload), code: 7, failure: "HELPER_EXIT_NONZERO", callbackSettled: true }))(501);
}

describe("captured collector fixtures equal exact accepted provider observations", () => {
  it.each([["healthy", healthy], ["privacy", provider]] as const)("conserves full %s fixture with its exact injected runner input", async (name, factory) => {
    const captured = provenance.captures.find((capture: { name: string }) => capture.name === name);
    const fixtureBytes = readFileSync(new URL(`./fixtures/census-${name}-observation.json`, import.meta.url), "utf8");
    calls.length = 0;
    const actual = await factory();
    expect(sha(readFileSync(new URL("../src/kernel-process-probe.ts", import.meta.url), "utf8"))).toBe(provenance.source.provider_sha256);
    expect(calls).toStrictEqual(captured.calls);
    expect(sha((calls[0] as { result: { stdout: string } }).result.stdout)).toBe(captured.inputStdoutSha256);
    expect(actual).toStrictEqual(JSON.parse(fixtureBytes));
    expect(JSON.stringify(actual, null, 2) + "\n").toBe(fixtureBytes);
    expect(sha(fixtureBytes)).toBe(captured.outputSha256);
    expect(sha(JSON.stringify(actual))).toBe(captured.compactOutputSha256);
  });
});
