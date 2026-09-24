# cmuxlayer docs

Start with the [README](../README.md) for install and the public tool list.

## Guides

- [Fresh install](guides/fresh-install.md): set up a machine from `brew install` to a first spawned agent.
- [Registry-optional spawn and resume](guides/registry-optional-spawn.md): how agents launch and resume with or without registered launchers.
- [Agent routing and handling](guides/agent-routing-and-handling.md): the operator playbook for `send_to`, `wait_for` and stuck panes.
- [Releases, Homebrew, and dogfooding](guides/releases-and-brew.md): how releases ship through the tap.

## Reference

- [CLI reference](reference/cli-reference.md): how each agent CLI (Claude Code, Codex, Cursor, Gemini, Kiro) is launched, resumed, typed into and read.
- [Control-plane invariants](reference/control-plane-invariants.md): the agent state machine rules.
- [Sidebar and registry topology contract](reference/topology-contract.md)
- [Harness JSONL field map](reference/harness-jsonl-field-map.md): where token, context and model fields live in each CLI's session log.
- [Thin-core tool cut](reference/thin-core-tool-cut.md): why the public surface is 10 tools.
- [Claude channels](reference/claude-channels.md): the one-way `--channels` lifecycle notifications.
- [Inbox dispatch](reference/inbox.md): the file-backed write channel and its wake transport.

## Testing

- [Live agent harness](testing/live-agent-harness.md)
- [QA video harness](testing/qa-video-harness.md)
- [Daemon performance budgets](testing/performance-budgets.md)
- [Live seat soak](testing/soak.md)
- [Real-cmux contract lane](testing/contract-lane.md)
