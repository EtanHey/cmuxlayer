# Security policy

## Supported versions

Only the latest release is supported: the version that
`brew install etanhey/layers/cmuxlayer` installs. Fixes ship in a new release,
not as backports. `brew upgrade cmuxlayer` picks them up.

## Scope

In scope: the code in this repository, which covers the cmuxlayer MCP server, its daemon and
proxy, and the `cmuxlayer` CLI. cmux itself (the terminal app and its socket) is a separate
project: report cmux issues to [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux).

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on
[EtanHey/cmuxlayer](https://github.com/EtanHey/cmuxlayer/security/advisories/new).
The report reaches the repository owner.

Include the cmuxlayer version (`cmuxlayer --version`), your cmux version, and the
steps to reproduce. Useful areas to check are the cmux socket and its
credentials, input forwarded to panes, and paths cmuxlayer reads or writes under
`~/.cmux`.
