import { describe, expect, it } from "vitest";
import {
  repoRootSearchCandidates,
  resolveRepoRootWithoutRegistry,
} from "../src/repo-root-fallback.js";

const BASE = {
  cwd: "/work/checkouts/cmuxlayer",
  homeDir: "/home/tester",
  env: {} as Record<string, string | undefined>,
};

describe("repo root fallback (no launcher registry)", () => {
  it("orders candidates env-roots first, then cwd, sibling, and home defaults", () => {
    expect(
      repoRootSearchCandidates("brainlayer", {
        ...BASE,
        env: { CMUXLAYER_REPO_HOME: "/srv/repos:/opt/src" },
      }),
    ).toEqual([
      "/srv/repos/brainlayer",
      "/opt/src/brainlayer",
      "/work/checkouts/brainlayer",
      "/home/tester/Gits/brainlayer",
      "/home/tester/brainlayer",
    ]);
  });

  it("includes the running cwd itself when its basename is the repo", () => {
    expect(repoRootSearchCandidates("cmuxlayer", BASE)[0]).toBe(
      "/work/checkouts/cmuxlayer",
    );
  });

  it("matches the running cwd across hyphen/underscore spelling", () => {
    expect(
      repoRootSearchCandidates("agent_html_host", {
        ...BASE,
        cwd: "/work/checkouts/agent-html-host",
      })[0],
    ).toBe("/work/checkouts/agent-html-host");
  });

  it("resolves to the first candidate that exists on disk", () => {
    expect(
      resolveRepoRootWithoutRegistry("brainlayer", {
        ...BASE,
        isDirectory: (path) => path === "/home/tester/Gits/brainlayer",
      }),
    ).toBe("/home/tester/Gits/brainlayer");
  });

  it("throws a self-answering error listing every searched path", () => {
    expect(() =>
      resolveRepoRootWithoutRegistry("brainlayer", {
        ...BASE,
        isDirectory: () => false,
      }),
    ).toThrow(
      /Cannot resolve a working directory for repo "brainlayer".*\/work\/checkouts\/brainlayer.*\/home\/tester\/Gits\/brainlayer.*CMUXLAYER_REPO_HOME/s,
    );
  });

  it("carries a registry-status hint into the failure when one is supplied", () => {
    expect(() =>
      resolveRepoRootWithoutRegistry("brainlayer", {
        ...BASE,
        isDirectory: () => false,
        registryHint: "Launcher registry has no entry for \"brainlayer\"",
      }),
    ).toThrow(/Launcher registry has no entry for "brainlayer"/);
  });

  it("rejects repo names that are not safe path segments", () => {
    expect(() =>
      repoRootSearchCandidates("../escape", BASE),
    ).toThrow(/Invalid repo name/);
  });

  it("ignores blank segments in CMUXLAYER_REPO_HOME", () => {
    expect(
      repoRootSearchCandidates("brainlayer", {
        ...BASE,
        env: { CMUXLAYER_REPO_HOME: "/srv/repos::  :" },
      })[0],
    ).toBe("/srv/repos/brainlayer");
  });
});
