# Security policy

## Supported versions

Only the latest release is supported: the version that
`brew install etanhey/layers/cmuxlayer` installs. Fixes ship in a new release,
not as backports. `brew upgrade cmuxlayer` picks them up.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on
[EtanHey/cmuxlayer](https://github.com/EtanHey/cmuxlayer/security/advisories/new).
The report reaches the repository owner.

Include the cmuxlayer version (`cmuxlayer --version`), your cmux version, and the
steps to reproduce. Useful areas to check are the cmux socket and its
credentials, input forwarded to panes, and paths cmuxlayer reads or writes under
`~/.cmux`.
