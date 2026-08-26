import { describe, expect, it } from "vitest";
import {
  loadLauncherRegistrySnapshot,
  parseLauncherRegistry,
  resolveLauncherNameFromRegistry,
  resolveLauncherPrefix,
  resolveLauncherNameFromRegistryOrNull,
  resolveRepoRootFromLauncherRegistry,
  resolveRepoRootFromLauncherRegistryOrNull,
} from "../src/launcher-registry.js";

const REGISTRY = `
# comments and blanks are ignored
repoGolem mm "/home/test-user/Gits/matchmat"
repoGolem cmuxlayer "/home/test-user/Gits/cmuxlayer"
repoGolem hyphen "/home/test-user/Gits/hyphen-repo"
`;

describe("launcher registry", () => {
  it("parses repoGolem prefix/path entries including prefix != basename", () => {
    expect(parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh")).toEqual([
      {
        prefix: "mm",
        path: "/home/test-user/Gits/matchmat",
        repoBasename: "matchmat",
      },
      {
        prefix: "cmuxlayer",
        path: "/home/test-user/Gits/cmuxlayer",
        repoBasename: "cmuxlayer",
      },
      {
        prefix: "hyphen",
        path: "/home/test-user/Gits/hyphen-repo",
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
    ).toBe("/home/test-user/Gits/hyphen-repo");
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

describe("registry-optional resolution (issue #392)", () => {
  const missingRegistry = {
    sourcePath: "/missing/launchers.zsh",
    readRegistry: (): string => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };

  it("reports an absent registry as unavailable instead of throwing", () => {
    const snapshot = loadLauncherRegistrySnapshot(missingRegistry);

    expect(snapshot.available).toBe(false);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.sourcePath).toBe("/missing/launchers.zsh");
    expect(snapshot.unavailable_reason).toMatch(/ENOENT/);
  });

  it("reports a present registry as available", () => {
    const snapshot = loadLauncherRegistrySnapshot({
      sourcePath: "/tmp/launchers.zsh",
      readRegistry: () => REGISTRY,
    });

    expect(snapshot.available).toBe(true);
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.unavailable_reason).toBeNull();
  });

  it("returns null launcher/root when the registry file is absent", () => {
    expect(
      resolveLauncherNameFromRegistryOrNull("matchmat", "claude", missingRegistry),
    ).toBeNull();
    expect(
      resolveRepoRootFromLauncherRegistryOrNull("matchmat", missingRegistry),
    ).toBeNull();
  });

  it("returns null when the registry exists but the repo is unregistered", () => {
    const entries = parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh");

    expect(
      resolveLauncherNameFromRegistryOrNull("unknown", "claude", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toBeNull();
    expect(
      resolveRepoRootFromLauncherRegistryOrNull("unknown", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toBeNull();
  });

  it("still answers registered repos exactly as the strict resolver does", () => {
    const entries = parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh");
    const options = { entries, sourcePath: "/tmp/launchers.zsh" };

    expect(resolveLauncherNameFromRegistryOrNull("matchmat", "claude", options)).toBe(
      resolveLauncherNameFromRegistry("matchmat", "claude", options),
    );
    expect(resolveRepoRootFromLauncherRegistryOrNull("hyphen", options)).toBe(
      resolveRepoRootFromLauncherRegistry("hyphen", options),
    );
  });

  it("still throws on a genuinely broken registry rather than falling back", () => {
    const ambiguous = {
      entries: parseLauncherRegistry(
        `repoGolem first "/tmp/one/shared"\nrepoGolem second "/tmp/two/shared"\n`,
        "/tmp/launchers.zsh",
      ),
      sourcePath: "/tmp/launchers.zsh",
    };

    expect(() =>
      resolveRepoRootFromLauncherRegistryOrNull("shared", ambiguous),
    ).toThrow(/Ambiguous launcher registry match/);

    expect(() =>
      resolveRepoRootFromLauncherRegistryOrNull("relative", {
        entries: [
          {
            prefix: "relative",
            path: "../somewhere-else",
            repoBasename: "somewhere-else",
          },
        ],
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toThrow(/must be absolute/);
  });

  it("returns null for a cli that has no launcher suffix (kiro is raw already)", () => {
    const entries = parseLauncherRegistry(REGISTRY, "/tmp/launchers.zsh");

    expect(
      resolveLauncherNameFromRegistryOrNull("matchmat", "kiro", {
        entries,
        sourcePath: "/tmp/launchers.zsh",
      }),
    ).toBeNull();
  });
});
