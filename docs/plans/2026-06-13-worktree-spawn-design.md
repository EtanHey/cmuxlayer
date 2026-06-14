# Worktree Spawn Design

**Goal:** Let leads spawn workers into fresh or reused git worktrees from cmuxlayer while preserving the existing cmux role layout and inherited MCP setup by default.

**Approved default:** Worktree workers inherit the parent/default MCP setup unless the caller chooses a narrower profile.

## Tool Contract

`spawn_agent` accepts:

```ts
worktree?: boolean | {
  create?: boolean;
  reuse?: boolean;
  name?: string;
  path?: string;
  branch?: string;
  base?: string;
};
mcp_profile?: "inherit" | "sterile" | "skill_eval" | {
  include?: string[];
  exclude?: string[];
};
```

`new_worktree_split` is a convenience wrapper for one worker. It uses the same fields, defaults `role` to `worker`, and returns the same spawn metadata plus worktree metadata.

## Architecture

Worktree creation lives in a small helper module instead of `server.ts`. The helper validates repo/name/path input, creates or reuses a git worktree under `~/Gits/<repo>.wt/<name>` by default, and returns the launch cwd.

`AgentEngine.spawnAgent` receives the resolved `cwd` and `mcp_profile`, but keeps the current cmux surface placement code. Workers still go right, orchestrators/domain leads still go left. Only the command sent into the new terminal changes: launcher commands are prefixed with `cd <worktree> && ...` and MCP profile env is exported for launchers to consume.

## MCP Profiles

- `inherit`: default. No sterile filtering. Sets `CMUXLAYER_MCP_PROFILE=inherit`.
- `sterile`: sets `CMUXLAYER_MCP_PROFILE=sterile`.
- `skill_eval`: sets `CMUXLAYER_MCP_PROFILE=skill_eval`.
- custom include/exclude: sets `CMUXLAYER_MCP_PROFILE=custom`, `CMUXLAYER_MCP_INCLUDE`, and `CMUXLAYER_MCP_EXCLUDE`.

This deliberately avoids raw config passing. Launchers can map these profile hints to their own Codex/Claude config behavior.

## Safety

- No cmux restart.
- No destructive git operations.
- Existing worktrees are reused only when `reuse` is true.
- User-supplied paths must be absolute and must stay under `~/Gits` unless explicitly allowed later.
- `node_modules` is symlinked from the main checkout when present and absent in the worktree, because prior cmuxlayer worker incidents showed this is required for seamless local tests. The symlink is never committed.

## Tests

- Worktree helper creates the expected `git worktree add -b ... <path> <base>` command.
- Existing worktree reuse skips creation.
- `spawn_agent({ worktree: true })` launches from the worktree cwd, preserves worker role placement, and defaults to `mcp_profile: "inherit"`.
- Custom MCP profiles are converted to env hints without exposing raw config.
