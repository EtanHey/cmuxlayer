# Agent Contract Spine Proposal

Status: proposal after cmux runtime hotfix
Owner: codex-modelguard
Date: 2026-06-18

## Problem

The Cursor model contract was encoded in the repoGolem shell launcher, but the
actual cmux MCP spawn path can bypass that shell-level refusal by generating a
launcher command with `-m/--model` before repoGolem receives control.

The immediate bug was:

- caller invokes `spawn_agent({ cli: "cursor", model: "sonnet" })`
- cmuxlayer builds a Cursor launcher command with a hardcoded model flag
- repoGolem's shell guard is in the wrong layer for this direct MCP path

## Hotfix Shipped In cmuxlayer

cmuxlayer now normalizes spawn models inside `AgentEngine.spawnAgent` before:

- preflight
- state persistence
- launcher command construction
- MCP result formatting

Runtime rule:

- Cursor default is always `auto`.
- Cursor requests for Claude-family models (`sonnet`, `opus`, `haiku`,
  `claude-*`) are coerced to `auto`.
- Cursor requests for any other non-default model are also coerced to `auto`.
- The only escape hatch is `REPOGOLEM_ALLOW_MODEL=1`.
- Coercions return a loud warning in the spawn result and formatted text.

This kills the recurring runtime leak tonight, including calls through
`spawn_agent`, `new_worktree_split`, `spawn_in_workspace`, and direct
`AgentEngine.spawnAgent` users.

## Required Spine

Long-term policy must live in one source of truth, not in both:

- `golems/scripts/repogolem/golem-dispatch.zsh`
- `cmuxlayer/src/model-policy.ts`

Recommended home: `controllayer`, because it is the control-plane spine rather
than a single launcher or a single MCP server.

Suggested package shape:

```text
controllayer/
  packages/agent-contract/
    agent-contract.json
    src/index.ts
    bin/agent-contract
```

`agent-contract.json` is the canonical data:

```json
{
  "version": 1,
  "escapeEnv": "REPOGOLEM_ALLOW_MODEL",
  "cli": {
    "cursor": {
      "defaultModel": "auto",
      "allowModelOverrideByDefault": false,
      "forbiddenModelPatterns": ["^claude-", "sonnet", "opus", "haiku"]
    }
  }
}
```

Consumers:

- cmuxlayer imports the TypeScript API and calls
  `resolveSpawnModelPolicy(cli, requestedModel, env)` before building launcher
  commands.
- repoGolem shell calls `agent-contract resolve --cli cursor --model "$model"`
  or reads the JSON through `jq` for the same policy decision.
- future UI/control tools read the same policy for form defaults and validation.

## Migration Plan

1. Create the controllayer contract package with JSON policy plus TypeScript and
   CLI adapters.
2. Add unit tests in controllayer for Cursor `sonnet`, `opus`, `haiku`,
   `claude-*`, blank, `auto`, and `REPOGOLEM_ALLOW_MODEL=1`.
3. Update cmuxlayer to depend on the contract package instead of local
   `src/model-policy.ts`.
4. Update repoGolem `golem-dispatch.zsh` to call the same contract package or
   read the same JSON, replacing duplicated shell logic.
5. Add a drift test that fails if cmuxlayer and repoGolem do not both reference
   the same contract version.

## Tonight Scope Decision

Full extraction crosses at least three repos (`controllayer`, `golems`,
`cmuxlayer`) and requires packaging plus shell integration verification. That is
too large for the immediate recurring-bug PR.

This PR should ship the runtime cmux guard now, with this proposal as the
tracked follow-up design. The next PR should move the exact policy from
`cmuxlayer/src/model-policy.ts` into the controllayer spine and make repoGolem
consume it.
