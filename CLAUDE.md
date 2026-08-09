@AGENTS.md

## Worktree spawn contract

- For managed worktree spawns, `repo` selects the repoGolem registration and names the worker; it
  does not imply `~/Gits/<repo>`.
- Resolve the repository root from the absolute path in the launcher registry. Registered roots
  outside `~/Gits` are valid, and their default worktrees live at `<registered-root>/.worktrees/`.
- If spawning fails after cmuxlayer creates a worktree, remove both that worktree and its new branch.
  Never roll back a reused worktree.
