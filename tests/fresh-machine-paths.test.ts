/**
 * E0 sweep: paths a fresh machine would hit.
 *
 * AGENTS.md law — "someone installing this fresh has none of my skills or
 * launchers". `~/Gits` and the sibling-repo state directory are allowed as
 * DEFAULTS; these tests pin that they are not load-bearing when absent.
 */

import { describe, expect, it } from "vitest";
import {
  defaultRepoCheckoutPath,
  firstRepoHomeRoot,
  REPO_HOME_ENV,
} from "../src/repo-root-fallback.js";
import { defaultKiroCd } from "../src/agent-command.js";
import { defaultSeatManifestDir } from "../src/seat-manifest.js";
import { mcpConfigScanRoots } from "../src/doctor.js";

describe("firstRepoHomeRoot", () => {
  it("is null when nothing is configured", () => {
    expect(firstRepoHomeRoot({})).toBeNull();
  });

  it("takes the first absolute root of the colon-separated list", () => {
    expect(
      firstRepoHomeRoot({ [REPO_HOME_ENV]: "relative:/code:/work" }),
    ).toBe("/code");
  });
});

describe("defaultRepoCheckoutPath", () => {
  it("follows the configured checkout root", () => {
    expect(
      defaultRepoCheckoutPath("alpha", {
        env: { [REPO_HOME_ENV]: "/code" },
        homeDir: "/home/tester",
      }),
    ).toBe("/code/alpha");
  });

  it("keeps the historical default when nothing is configured", () => {
    expect(
      defaultRepoCheckoutPath("alpha", { env: {}, homeDir: "/home/tester" }),
    ).toBe("/home/tester/Gits/alpha");
  });

  it("refuses a repo name that could escape the root", () => {
    expect(() =>
      defaultRepoCheckoutPath("../etc", { env: {}, homeDir: "/home/tester" }),
    ).toThrow(/Invalid repo name/);
  });
});

describe("defaultKiroCd", () => {
  it("keeps the historical literal on an unconfigured machine", () => {
    expect(defaultKiroCd("brainlayer", {})).toBe("cd ~/Gits/brainlayer && ");
  });

  it("cds into the configured checkout root when one is set", () => {
    expect(defaultKiroCd("brainlayer", { [REPO_HOME_ENV]: "/code" })).toBe(
      "cd '/code/brainlayer' && ",
    );
  });
});

describe("defaultSeatManifestDir", () => {
  it("does not conjure a sibling repo's tree on a machine without it", () => {
    expect(defaultSeatManifestDir({ HOME: "/home/tester" }, () => false)).toBe(
      "/home/tester/.local/state/cmuxlayer/seat-manifests",
    );
  });
});

describe("mcpConfigScanRoots", () => {
  it("scans the configured checkout roots when they are set", () => {
    expect(
      mcpConfigScanRoots({ [REPO_HOME_ENV]: "/code:/work" }, "/home/tester"),
    ).toEqual(["/code", "/work"]);
  });

  it("falls back to the historical default", () => {
    expect(mcpConfigScanRoots({}, "/home/tester")).toEqual([
      "/home/tester/Gits",
    ]);
  });

  it("ignores relative entries rather than scanning the process cwd", () => {
    expect(
      mcpConfigScanRoots({ [REPO_HOME_ENV]: "relative" }, "/home/tester"),
    ).toEqual(["/home/tester/Gits"]);
  });
});
