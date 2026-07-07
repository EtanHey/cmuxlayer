import { describe, expect, it } from "vitest";
import {
  parseLauncherRegistry,
  resolveLauncherNameFromRegistry,
  resolveLauncherPrefix,
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
