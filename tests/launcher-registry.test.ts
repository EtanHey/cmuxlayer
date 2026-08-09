import { describe, expect, it } from "vitest";
import {
  parseLauncherRegistry,
  resolveLauncherNameFromRegistry,
  resolveLauncherPrefix,
  resolveRepoRootFromLauncherRegistry,
} from "../src/launcher-registry.js";

const REGISTRY = `
# comments and blanks are ignored
repoGolem mm "/Users/etanheyman/Gits/matchmat"
repoGolem cmuxlayer "/Users/etanheyman/Gits/cmuxlayer"
repoGolem hyphen "/Users/etanheyman/Gits/hyphen-repo"
`;

describe("launcher registry", () => {
  it("parses repoGolem prefix/path entries including prefix != basename", () => {
    expect(parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh")).toEqual([
      {
        prefix: "mm",
        path: "/Users/etanheyman/Gits/matchmat",
        repoBasename: "matchmat",
      },
      {
        prefix: "cmuxlayer",
        path: "/Users/etanheyman/Gits/cmuxlayer",
        repoBasename: "cmuxlayer",
      },
      {
        prefix: "hyphen",
        path: "/Users/etanheyman/Gits/hyphen-repo",
        repoBasename: "hyphen-repo",
      },
    ]);
  });

  it("resolves a repo basename and direct prefix to the registered prefix", () => {
    const entries = parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh");

    expect(resolveLauncherPrefix("matchmat", entries)).toBe("mm");
    expect(resolveLauncherPrefix("mm", entries)).toBe("mm");
    expect(resolveLauncherPrefix("hyphen_repo", entries)).toBe("hyphen");
  });

  it("returns registered launcher names for repo names and prefixes", () => {
    const entries = parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh");

    expect(
      resolveLauncherNameFromRegistry("matchmat", "claude", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toBe("mmClaude");
    expect(
      resolveLauncherNameFromRegistry("mm", "claude", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toBe("mmClaude");
  });

  it("resolves the registered repo path independently of the registry key", () => {
    const entries = parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh");

    expect(
      resolveRepoRootFromLauncherRegistry("hyphen", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toBe("/Users/etanheyman/Gits/hyphen-repo");
  });

  it("prefers an exact registry prefix over an earlier basename alias", () => {
    const entries = parseLauncherRegistry(
      `repoGolem alias "/tmp/other/golems"\nrepoGolem golems "/tmp/canonical"\n`,
      "/tmp/launchers.zsh",
    );

    expect(
      resolveRepoRootFromLauncherRegistry("golems", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toBe("/tmp/canonical");
  });

  it("rejects an ambiguous basename match across different registry paths", () => {
    const entries = parseLauncherRegistry(
      `repoGolem first "/tmp/one/shared"\nrepoGolem second "/tmp/two/shared"\n`,
      "/tmp/launchers.zsh",
    );

    expect(() =>
      resolveRepoRootFromLauncherRegistry("shared", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toThrow(/Ambiguous launcher registry match.*first=.*second=.*exact launcher prefix/s);
  });

  it("rejects a relative registry repo path instead of resolving it from cmuxlayer cwd", () => {
    expect(() =>
      resolveRepoRootFromLauncherRegistry("relative", {
        entries: [
          {
            prefix: "relative",
            path: "../somewhere-else",
            repoBasename: "somewhere-else",
          },
        ],
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toThrow(/must be absolute.*\.\.\/somewhere-else.*launchers\.zsh/s);
  });

  it("throws a self-answering miss error with source and registered launchers", () => {
    const entries = parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh");

    expect(() =>
      resolveLauncherNameFromRegistry("unknown", "claude", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toThrow(
      /Launcher registry miss.*unknownClaude.*\/tmp\/launchers\.zsh.*matchmat.*mmClaude.*mmCodex/s,
    );
  });

  it("reports a missing registry file as a clear registry error", () => {
    expect(() =>
      resolveLauncherNameFromRegistry("matchmat", "claude", {
        readRegistry: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        sourcePath: "/missing/launchers.zsh",
      }),
    ).toThrow(/Launcher registry unavailable.*\/missing\/launchers\.zsh/s);
  });
});
