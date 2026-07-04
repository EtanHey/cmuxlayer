import { describe, expect, it } from "vitest";
import {
  findWorkspaceRefForRepo,
  repoNameMatchesWorkspaceDirectory,
  reposEquivalent,
  resolveWorkspaceRefForRepo,
  workspaceDirectoryRepoMatchScore,
} from "../src/repo-workspace.js";

describe("workspaceDirectoryRepoMatchScore", () => {
  it("scores an exact repo-root basename highest", () => {
    expect(
      workspaceDirectoryRepoMatchScore(
        "brainlayer",
        "/Users/x/Gits/brainlayer",
      ),
    ).toBe(2);
  });

  it("matches a <repo>.wt worktree directory as a segment", () => {
    // ~/Gits/brainlayer.wt/watcher-fix — basename is the worktree name, not the
    // repo, so this must match via the ".wt" segment, scored below the root.
    expect(
      workspaceDirectoryRepoMatchScore(
        "brainlayer",
        "/Users/x/Gits/brainlayer.wt/watcher-fix",
      ),
    ).toBe(1);
  });

  it("matches a .worktrees layout via the repo segment", () => {
    expect(
      workspaceDirectoryRepoMatchScore(
        "brainlayer",
        "/Users/x/Gits/brainlayer/.worktrees/wf1-popover",
      ),
    ).toBe(1);
  });

  it("is hyphen-insensitive", () => {
    expect(
      workspaceDirectoryRepoMatchScore("cmux-layer", "/Users/x/Gits/cmuxlayer"),
    ).toBe(2);
  });

  it("scores path-shaped repo roots and their worktree directories", () => {
    expect(
      workspaceDirectoryRepoMatchScore(
        "/example/workspaces/cmuxlayer",
        "/example/workspaces/cmuxlayer",
      ),
    ).toBe(2);
    expect(
      workspaceDirectoryRepoMatchScore(
        "/example/workspaces/cmuxlayer.wt/cmuxlayer-worker-1",
        "/example/workspaces/cmuxlayer",
      ),
    ).toBe(2);
  });

  it("treats a path under an unrelated .wt ancestor as the final repo basename", () => {
    expect(
      workspaceDirectoryRepoMatchScore(
        "/Users/x/outer.wt/nestedrepo",
        "/Users/x/outer.wt/nestedrepo",
      ),
    ).toBe(2);
    expect(
      workspaceDirectoryRepoMatchScore(
        "/Users/x/outer.wt/nestedrepo",
        "/Users/x/Gits/outer",
      ),
    ).toBe(0);
  });

  it("does not match an unrelated sibling repo (no substring/prefix match)", () => {
    expect(
      workspaceDirectoryRepoMatchScore(
        "cmuxlayer",
        "/Users/x/Gits/cmuxlayer-fork",
      ),
    ).toBe(0);
    expect(
      repoNameMatchesWorkspaceDirectory(
        "cmuxlayer",
        "/Users/x/Gits/cmuxlayer-fork",
      ),
    ).toBe(false);
  });
});

describe("findWorkspaceRefForRepo", () => {
  it("prefers the repo-root workspace over a worktree workspace for the same repo", () => {
    const ref = findWorkspaceRefForRepo(
      [
        {
          ref: "ws:worktree",
          current_directory: "/Users/x/Gits/brainlayer.wt/a",
        },
        { ref: "ws:root", current_directory: "/Users/x/Gits/brainlayer" },
      ],
      "brainlayer",
    );
    expect(ref).toBe("ws:root");
  });

  it("honors a preferred ref (parent workspace) even across same-repo matches", () => {
    const ref = findWorkspaceRefForRepo(
      [
        { ref: "ws:root", current_directory: "/Users/x/Gits/brainlayer" },
        {
          ref: "ws:worktree",
          current_directory: "/Users/x/Gits/brainlayer.wt/a",
        },
      ],
      "brainlayer",
      { preferredRef: "ws:worktree" },
    );
    expect(ref).toBe("ws:worktree");
  });

  it("breaks ties on the selected workspace deterministically (not list order)", () => {
    const ref = findWorkspaceRefForRepo(
      [
        { ref: "ws:a", current_directory: "/Users/x/Gits/brainlayer.wt/a" },
        {
          ref: "ws:b",
          current_directory: "/Users/x/Gits/brainlayer.wt/b",
          selected: true,
        },
      ],
      "brainlayer",
    );
    expect(ref).toBe("ws:b");
  });

  it("returns undefined when no workspace matches the repo", () => {
    expect(
      findWorkspaceRefForRepo(
        [{ ref: "ws:other", current_directory: "/Users/x/Gits/other" }],
        "brainlayer",
      ),
    ).toBeUndefined();
  });
});

describe("resolveWorkspaceRefForRepo", () => {
  it("resolves a worktree worker to its repo workspace", async () => {
    const ref = await resolveWorkspaceRefForRepo("brainlayer", async () => ({
      workspaces: [
        { ref: "ws:root", current_directory: "/Users/x/Gits/brainlayer" },
      ],
    }));
    expect(ref).toBe("ws:root");
  });

  it("swallows listWorkspaces errors and returns undefined", async () => {
    const ref = await resolveWorkspaceRefForRepo("brainlayer", async () => {
      throw new Error("socket down");
    });
    expect(ref).toBeUndefined();
  });
});

describe("segment matching is anchored to worktree shapes (no ancestor false-positives)", () => {
  it("does not match a repo name that merely coincides with an ancestor dir", () => {
    // A repo literally named "Gits" / the username must NOT claim an unrelated
    // workspace just because it nests under a same-named directory.
    expect(
      workspaceDirectoryRepoMatchScore("Gits", "/Users/x/Gits/brainlayer"),
    ).toBe(0);
    expect(
      workspaceDirectoryRepoMatchScore("x", "/Users/x/Gits/brainlayer"),
    ).toBe(0);
  });

  it("does not match a plain subdirectory of the repo (only true worktree shapes)", () => {
    expect(
      workspaceDirectoryRepoMatchScore(
        "brainlayer",
        "/Users/x/Gits/brainlayer/src/watcher",
      ),
    ).toBe(0);
  });

  it("still matches the two real worktree layouts", () => {
    expect(
      workspaceDirectoryRepoMatchScore(
        "brainlayer",
        "/Users/x/Gits/brainlayer.wt/a",
      ),
    ).toBe(1);
    expect(
      workspaceDirectoryRepoMatchScore(
        "brainlayer",
        "/Users/x/Gits/brainlayer/.worktrees/a",
      ),
    ).toBe(1);
  });
});

describe("findWorkspaceRefForRepo determinism", () => {
  it("picks the lexicographically smallest ref among equal-rank ties, order-independent", () => {
    const candidates = [
      { ref: "ws:b", current_directory: "/Users/x/Gits/brainlayer.wt/b" },
      { ref: "ws:a", current_directory: "/Users/x/Gits/brainlayer.wt/a" },
    ];
    expect(findWorkspaceRefForRepo(candidates, "brainlayer")).toBe("ws:a");
    expect(
      findWorkspaceRefForRepo([...candidates].reverse(), "brainlayer"),
    ).toBe("ws:a");
  });
});

describe("reposEquivalent", () => {
  it("is case- and hyphen-insensitive and symmetric", () => {
    expect(reposEquivalent("cmux-layer", "cmuxlayer")).toBe(true);
    expect(reposEquivalent("cmuxlayer", "cmux-layer")).toBe(true);
    expect(reposEquivalent("Brainlayer", "brainlayer")).toBe(true);
    expect(reposEquivalent("brainlayer", "voicelayer")).toBe(false);
  });

  it("treats a repo root path and a same-repo worktree path as equivalent", () => {
    expect(
      reposEquivalent(
        "/example/workspaces/cmuxlayer",
        "/example/workspaces/cmuxlayer.wt/cmuxlayer-worker-1",
      ),
    ).toBe(true);
  });

  it("does not let an unrelated .wt ancestor replace the repo basename", () => {
    expect(
      reposEquivalent("/Users/x/outer.wt/nestedrepo", "nestedrepo"),
    ).toBe(true);
    expect(reposEquivalent("/Users/x/outer.wt/nestedrepo", "outer")).toBe(
      false,
    );
  });
});
