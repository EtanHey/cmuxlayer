#!/usr/bin/env bash
#
# Cut a cmuxlayer release and bump the Homebrew formula, in one go.
#
#   scripts/release.sh 0.3.0                     # full release (asks once before pushing)
#   scripts/release.sh 0.3.0 --yes               # no confirmation prompt
#   scripts/release.sh 0.3.0 --dry-run           # print every step, change nothing
#   scripts/release.sh 0.3.0 --require-contract  # a skipped real-cmux gate aborts the release
#   scripts/release.sh 0.3.0 --require-ci        # a non-green CI on HEAD aborts the release
#
# Steps: clean-tree + green build/tests gate → bump package.json → commit +
# push main → tag vX.Y.Z + push tag → update formula url+sha256 in the
# homebrew-layers tap → push tap → sync the tap clone Homebrew itself reads →
# tell you to run release verification.
#
# Every step writes into a durable release receipt (see scripts/release-receipt.mjs)
# so "did this release actually gate, ship, and land?" is answered by a file and
# not by terminal scrollback.
#
# See docs/releases-and-brew.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAP_DIR="${CMUXLAYER_TAP_DIR:-$HOME/Gits/homebrew-layers}"
FORMULA="$TAP_DIR/Formula/cmuxlayer.rb"
TARBALL_URL_BASE="https://github.com/EtanHey/cmuxlayer/archive/refs/tags"
RECEIPT_CLI="$REPO_DIR/scripts/release-receipt.mjs"
BREW_TAP_CLONE_SUFFIX="Library/Taps/etanhey/homebrew-layers"

VERSION="${1:-}"
YES=0
DRY=0
REQUIRE_CONTRACT=0
REQUIRE_CI=0
CI_CONCLUSION="unknown"
for arg in "${@:2}"; do
  case "$arg" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --require-contract) REQUIRE_CONTRACT=1 ;;
    --require-ci) REQUIRE_CI=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

CONTRACT_LOG=""
TMP=""
cleanup() {
  [ -n "$CONTRACT_LOG" ] && rm -f "$CONTRACT_LOG"
  [ -n "$TMP" ] && rm -f "$TMP"
  return 0
}
trap cleanup EXIT

die() { echo "release: $*" >&2; exit 1; }
run() { if [ "$DRY" -eq 1 ]; then printf 'DRY  %s\n' "$*"; else eval "$@"; fi; }

# In-place sed that works on BSD *and* GNU. `sed -i ''` is BSD-only: GNU sed
# reads the '' as the script and the expression as a filename, exits 2, and
# takes this script down with it — which is why every Linux CI run of the
# release-receipt tests failed while the same tests passed on a Mac.
sed_inplace() {
  local expression="$1" file="$2" tmp
  tmp="$(mktemp)"
  sed -E "$expression" "$file" >"$tmp" && mv "$tmp" "$file"
}

# Receipt writes are never allowed to fail a release: the ledger records the
# release, it does not gate it.
receipt() {
  if [ "$DRY" -eq 1 ]; then
    printf 'DRY  receipt %s\n' "$*"
    return 0
  fi
  node "$RECEIPT_CLI" "$@" >/dev/null || echo "release: receipt write failed: $*" >&2
}
receipt_record() { receipt record "$VERSION" "$1" "$2"; }

[ -n "$VERSION" ] || die "usage: release.sh <X.Y.Z> [--yes] [--dry-run] [--require-contract]"
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

# --- open the receipt ------------------------------------------------------
RECEIPT_PATH=""
if [ "$DRY" -ne 1 ]; then
  receipt init "$VERSION"
  RECEIPT_PATH="$(node "$RECEIPT_CLI" path "$VERSION" 2>/dev/null || true)"
  receipt_record "gates.require_contract" "$([ "$REQUIRE_CONTRACT" -eq 1 ] && echo true || echo false)"
fi

# --- CI status of the commit being released (#490) -------------------------
# Six tagged releases shipped while publish.yml failed on every single run and
# cmuxlayer never reached npm at all. Nothing in the release said so. The receipt
# now carries CI's verdict on the released commit, and the banner prints it, so
# "the release looked clean" can never again mean "nobody opened the log".
if [ "$DRY" -eq 1 ]; then
  printf 'DRY  %s\n' "read CI status for HEAD"
else
  RELEASE_COMMIT="$(git rev-parse HEAD)"
  # An unusable gh -- absent, unauthenticated, offline -- reads as unknown.
  # Only a real `success` from a real run is allowed to look green.
  CI_CONCLUSION="$(gh run list --commit "$RELEASE_COMMIT" --workflow ci.yml \
    --limit 1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || true)"
  [ -n "$CI_CONCLUSION" ] || CI_CONCLUSION="unknown"
  receipt_record "gates.ci" "$CI_CONCLUSION"
  if [ "$CI_CONCLUSION" != "success" ]; then
    if [ "$REQUIRE_CI" -eq 1 ]; then
      die "--require-ci: CI for $RELEASE_COMMIT is $CI_CONCLUSION, not success"
    fi
    echo "release: WARNING — CI for $RELEASE_COMMIT is $CI_CONCLUSION; recorded in the receipt"
  fi
fi

echo "release: gating on typecheck + tests…"
run "bun run typecheck"
receipt_record "gates.typecheck" "pass"
run "env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bun run test"
receipt_record "gates.tests" "pass"

# --- real-cmux contract gate (#370) ---------------------------------------
# The lane skips itself when no live non-production cmux socket is reachable.
# A skip used to vanish into scrollback — three releases shipped without the
# gate ever running. It is now classified and written to the receipt, and
# --require-contract turns a skip into a hard stop.
echo "release: gating on real-cmux contracts (skip is recorded; --require-contract makes it fatal)…"
if [ "$DRY" -eq 1 ]; then
  printf 'DRY  %s\n' "bun run test:contract"
else
  CONTRACT_LOG="$(mktemp)"
  set +e
  if [ "$REQUIRE_CONTRACT" -eq 1 ]; then
    CMUX_CONTRACT_REQUIRE_LIVE=1 bun run test:contract 2>&1 | tee "$CONTRACT_LOG"
  else
    bun run test:contract 2>&1 | tee "$CONTRACT_LOG"
  fi
  CONTRACT_STATUS=${PIPESTATUS[0]}
  set -e

  # The verdict is SEARCHED for, never read off the tail: the runner's finally
  # block prints cleanup warnings AFTER its PASS/SKIP marker, and stdout/stderr
  # merge through one pipe — so the last line is not the lane's answer.
  CONTRACT_RESULT="fail"
  CONTRACT_REASON="$(awk 'NF { line = $0 } END { print line }' "$CONTRACT_LOG")"
  if [ "$CONTRACT_STATUS" -eq 0 ]; then
    if grep -q '^\[contract\] PASS real-cmux contract lane$' "$CONTRACT_LOG"; then
      CONTRACT_RESULT="pass"
      CONTRACT_REASON=""
    elif grep -q '^\[contract\] SKIP: ' "$CONTRACT_LOG"; then
      CONTRACT_RESULT="skip"
      CONTRACT_REASON="$(grep -m1 '^\[contract\] SKIP: ' "$CONTRACT_LOG" | sed -e 's/^\[contract\] SKIP: //')"
    else
      CONTRACT_RESULT="unknown"
      CONTRACT_REASON="contract lane exited zero without a PASS or SKIP marker"
    fi
  fi
  receipt_record "gates.contract" "$CONTRACT_RESULT"
  if [ -n "$CONTRACT_REASON" ]; then
    receipt_record "gates.contract_reason" "$CONTRACT_REASON"
  fi

  case "$CONTRACT_RESULT" in
    pass) ;;
    skip|unknown)
      # A zero exit is the lane saying it did not fail. Recording that and
      # warning is what this script has always done; only --require-contract
      # turns a non-pass into a stop.
      if [ "$REQUIRE_CONTRACT" -eq 1 ]; then
        die "--require-contract: the real-cmux contract gate did not pass ($CONTRACT_RESULT: $CONTRACT_REASON)"
      fi
      echo "release: WARNING — real-cmux contract gate $CONTRACT_RESULT ($CONTRACT_REASON); recorded in the receipt"
      ;;
    *)
      die "real-cmux contract gate failed: $CONTRACT_REASON" ;;
  esac
fi

CURRENT="$(grep -E '^  "version":' package.json | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')"
echo "release: $CURRENT → $VERSION"
receipt_record "previous_version" "$CURRENT"

if [ "$YES" -ne 1 ] && [ "$DRY" -ne 1 ]; then
  read -r -p "Release $TAG and push to cmuxlayer + homebrew-layers? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "aborted"
fi

# --- bump + commit + tag (cmuxlayer) --------------------------------------
run "sed_inplace 's/^(  \"version\": \")[^\"]+(\",)\$/\\1$VERSION\\2/' package.json"
run "git commit -aqm 'chore: release $TAG'"
run "git push origin main"
run "git tag -a '$TAG' -m 'cmuxlayer $TAG'"
run "git push origin '$TAG'"
if [ "$DRY" -ne 1 ]; then
  receipt_record "commit" "$(git rev-parse HEAD)"
  receipt_record "pushed" "true"
fi

# --- compute tarball sha256 -----------------------------------------------
URL="$TARBALL_URL_BASE/$TAG.tar.gz"
if [ "$DRY" -eq 1 ]; then
  echo "DRY  curl + shasum $URL"
  SHA="<sha256-of-$TAG>"
else
  TMP="$(mktemp)"
  # GitHub may take a moment to generate the tag tarball.
  for i in 1 2 3 4 5; do
    if curl -fsSL "$URL" -o "$TMP"; then break; fi
    echo "release: tarball not ready yet (attempt $i), retrying…" >&2; sleep 3
  done
  SHA="$(shasum -a 256 "$TMP" | awk '{print $1}')"
  [ -n "$SHA" ] || die "could not compute sha256 for $URL"
fi
echo "release: $TAG sha256 = $SHA"
receipt_record "artifact.url" "$URL"
receipt_record "artifact.sha256" "$SHA"

# --- bump formula (homebrew-layers) ---------------------------------------
run "sed_inplace 's|archive/refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz|archive/refs/tags/$TAG.tar.gz|' '$FORMULA'"
run "sed_inplace 's|^  sha256 \"[0-9a-f]{64}\"|  sha256 \"$SHA\"|' '$FORMULA'"
run "brew audit etanhey/layers/cmuxlayer || true"
run "git -C '$TAP_DIR' commit -aqm 'cmuxlayer $TAG'"
run "git -C '$TAP_DIR' push origin main"
receipt_record "tap.source_dir" "$TAP_DIR"
receipt_record "tap.pushed" "true"

# --- sync the tap clone Homebrew actually reads (#371, ledger row 16) ------
# Pushing ~/Gits/homebrew-layers is not the end of the release: brew reads its
# OWN clone under $(brew --repository), whose main often has no upstream
# tracking, so `brew update` can report "already up-to-date" while sitting
# commits behind. Syncing it here is additive — a failure is recorded, never
# fatal, because the release itself is already pushed by this point.
if [ "$DRY" -eq 1 ]; then
  printf 'DRY  %s\n' "sync brew tap clone under \$(brew --repository)/$BREW_TAP_CLONE_SUFFIX"
else
  BREW_TAP_CLONE=""
  if command -v brew >/dev/null 2>&1; then
    BREW_TAP_CLONE="$(brew --repository)/$BREW_TAP_CLONE_SUFFIX"
  fi
  if [ -z "$BREW_TAP_CLONE" ]; then
    receipt_record "tap.clone_sync" "skipped"
    receipt_record "tap.clone_reason" "brew is not installed on this Mac"
    echo "release: brew not installed — skipping tap-clone sync (recorded)"
  elif [ ! -d "$BREW_TAP_CLONE/.git" ]; then
    receipt_record "tap.clone_path" "$BREW_TAP_CLONE"
    receipt_record "tap.clone_sync" "skipped"
    receipt_record "tap.clone_reason" "no Homebrew tap clone at $BREW_TAP_CLONE (brew tap etanhey/layers)"
    echo "release: no brew tap clone at $BREW_TAP_CLONE — skipping sync (recorded)"
  else
    receipt_record "tap.clone_path" "$BREW_TAP_CLONE"
    CLONE_BEFORE="$(git -C "$BREW_TAP_CLONE" rev-parse HEAD 2>/dev/null || echo unknown)"
    receipt_record "tap.clone_before" "$CLONE_BEFORE"
    if git -C "$BREW_TAP_CLONE" fetch origin && \
       git -C "$BREW_TAP_CLONE" reset --hard origin/main >/dev/null; then
      CLONE_AFTER="$(git -C "$BREW_TAP_CLONE" rev-parse HEAD 2>/dev/null || echo unknown)"
      receipt_record "tap.clone_after" "$CLONE_AFTER"
      receipt_record "tap.clone_sync" "synced"
      echo "release: brew tap clone synced $CLONE_BEFORE → $CLONE_AFTER"
    else
      receipt_record "tap.clone_sync" "failed"
      receipt_record "tap.clone_reason" "fetch/reset failed in $BREW_TAP_CLONE"
      echo "release: WARNING — could not sync $BREW_TAP_CLONE; run release-verify.sh to sync it"
    fi
  fi
fi

if [ "$DRY" -eq 1 ]; then
  RECEIPT_LABEL="<dry-run: no receipt written>"
else
  RECEIPT_LABEL="${RECEIPT_PATH:-<receipt unavailable — is node installed? see warnings above>}"
fi

cat <<EOF

release: done — cmuxlayer $TAG is tagged and the formula is bumped.
CI: $CI_CONCLUSION (workflow ci.yml on the released commit)
Receipt: $RECEIPT_LABEL
Next (on EACH Mac — each run appends its own install evidence to the receipt):
  $REPO_DIR/scripts/release-verify.sh "$VERSION"
  $REPO_DIR/scripts/release-verify.sh "$VERSION" --verify-only   # never upgrades

# Outbox-semantics releases only (see docs/releases-and-brew.md "Pre-deploy hygiene"):
#   if this release changes outbox dedup-id derivation or the delivery gate,
#   archive+truncate ~/.golems-zikaron/outbox.md on EACH target Mac BEFORE the
#   new binary goes live. This is a manual, per-Mac step — intentionally NOT
#   auto-run here, since a release must never silently delete another operator's
#   pending messages. The in-code version-gated quarantine is the real guard.
EOF
