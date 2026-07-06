#!/usr/bin/env bash
#
# Cut a cmuxlayer release and bump the Homebrew formula, in one go.
#
#   scripts/release.sh 0.3.0            # full release (asks once before pushing)
#   scripts/release.sh 0.3.0 --yes      # no confirmation prompt
#   scripts/release.sh 0.3.0 --dry-run  # print every step, change nothing
#
# Steps: clean-tree + green build/tests gate → bump package.json → commit +
# push main → tag vX.Y.Z + push tag → update formula url+sha256 in the
# homebrew-layers tap → push tap → tell you to `brew upgrade`.
#
# See docs/releases-and-brew.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAP_DIR="${CMUXLAYER_TAP_DIR:-$HOME/Gits/homebrew-layers}"
FORMULA="$TAP_DIR/Formula/cmuxlayer.rb"
TARBALL_URL_BASE="https://github.com/EtanHey/cmuxlayer/archive/refs/tags"

VERSION="${1:-}"
YES=0
DRY=0
for arg in "${@:2}"; do
  case "$arg" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "release: $*" >&2; exit 1; }
run() { if [ "$DRY" -eq 1 ]; then printf 'DRY  %s\n' "$*"; else eval "$@"; fi; }

[ -n "$VERSION" ] || die "usage: release.sh <X.Y.Z> [--yes] [--dry-run]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be semver X.Y.Z, got '$VERSION'"
[ -f "$FORMULA" ] || die "formula not found at $FORMULA (set CMUXLAYER_TAP_DIR)"

cd "$REPO_DIR"
TAG="v$VERSION"

# --- preflight gates -------------------------------------------------------
if [ "$DRY" -ne 1 ]; then
  [ "$(git branch --show-current)" = "main" ] || die "not on main"
  git diff --quiet && git diff --cached --quiet || die "working tree is dirty; commit or stash first"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "local main is not in sync with origin/main"
  git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists"
fi

echo "release: gating on typecheck + tests…"
run "bun run typecheck"
run "bun run test"

CURRENT="$(grep -E '^  "version":' package.json | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')"
echo "release: $CURRENT → $VERSION"

if [ "$YES" -ne 1 ] && [ "$DRY" -ne 1 ]; then
  read -r -p "Release $TAG and push to cmuxlayer + homebrew-layers? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "aborted"
fi

# --- bump + commit + tag (cmuxlayer) --------------------------------------
run "sed -i '' -E 's/^(  \"version\": \")[^\"]+(\",)\$/\\1$VERSION\\2/' package.json"
run "git commit -aqm 'chore: release $TAG'"
run "git push origin main"
run "git tag -a '$TAG' -m 'cmuxlayer $TAG'"
run "git push origin '$TAG'"

# --- compute tarball sha256 -----------------------------------------------
URL="$TARBALL_URL_BASE/$TAG.tar.gz"
if [ "$DRY" -eq 1 ]; then
  echo "DRY  curl + shasum $URL"
  SHA="<sha256-of-$TAG>"
else
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  # GitHub may take a moment to generate the tag tarball.
  for i in 1 2 3 4 5; do
    if curl -fsSL "$URL" -o "$TMP"; then break; fi
    echo "release: tarball not ready yet (attempt $i), retrying…" >&2; sleep 3
  done
  SHA="$(shasum -a 256 "$TMP" | awk '{print $1}')"
  [ -n "$SHA" ] || die "could not compute sha256 for $URL"
fi
echo "release: $TAG sha256 = $SHA"

# --- bump formula (homebrew-layers) ---------------------------------------
run "sed -i '' -E 's|archive/refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz|archive/refs/tags/$TAG.tar.gz|' '$FORMULA'"
run "sed -i '' -E 's|^  sha256 \"[0-9a-f]{64}\"|  sha256 \"$SHA\"|' '$FORMULA'"
run "brew audit etanhey/layers/cmuxlayer || true"
run "git -C '$TAP_DIR' commit -aqm 'cmuxlayer $TAG'"
run "git -C '$TAP_DIR' push origin main"

cat <<EOF

release: done — cmuxlayer $TAG is tagged and the formula is bumped.
Next:
  brew update && brew upgrade etanhey/layers/cmuxlayer

# Outbox-semantics releases only (see docs/releases-and-brew.md "Pre-deploy hygiene"):
#   if this release changes outbox dedup-id derivation or the delivery gate,
#   archive+truncate ~/.golems-zikaron/outbox.md on EACH target Mac BEFORE the
#   new binary goes live. This is a manual, per-Mac step — intentionally NOT
#   auto-run here, since a release must never silently delete another operator's
#   pending messages. The in-code version-gated quarantine is the real guard.
EOF
