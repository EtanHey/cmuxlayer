#!/usr/bin/env bash
# Sync the tap clone Homebrew actually reads, upgrade cmuxlayer, and verify it.
set -euo pipefail

die() { echo "release-verify: $*" >&2; exit 1; }

VERSION="${1:-}"
[ -n "$VERSION" ] || die "usage: release-verify.sh <X.Y.Z>"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be semver X.Y.Z, got '$VERSION'"
command -v brew >/dev/null 2>&1 || die "brew is not installed"

BREW_TAP_DIR="$(brew --repository)/Library/Taps/etanhey/homebrew-layers"
[ -d "$BREW_TAP_DIR/.git" ] || die "Homebrew tap clone not found at $BREW_TAP_DIR"

git -C "$BREW_TAP_DIR" fetch origin
git -C "$BREW_TAP_DIR" reset --hard origin/main
brew upgrade etanhey/layers/cmuxlayer

INSTALLED="$(brew list --versions cmuxlayer)"
[ "$INSTALLED" = "cmuxlayer $VERSION" ] || die "expected cmuxlayer $VERSION, got '${INSTALLED:-not installed}'"

echo "release-verify: cmuxlayer $VERSION is installed from the synced tap"
