# MCP orphan reaper LaunchAgent

Render and inspect the portable plist without changing launchd:

```bash
scripts/install-mcp-reaper.sh --dry-run
```

After `bun run build`, the Etan-gated install is:

```bash
scripts/install-mcp-reaper.sh --install
```

The installer XML-escapes the checkout path, lints the rendered plist, writes
`~/Library/LaunchAgents/com.cmuxlayer.mcp-reaper.plist`, and only then reloads
the job. The plist keeps `REAPER_DRY_RUN=1`; changing execution mode remains a
separate reviewed action.
