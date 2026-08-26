#!/usr/bin/env bash
# Sync the tap clone Homebrew actually reads, upgrade cmuxlayer, and verify it.
#
#   release-verify.sh 0.4.44                 # sync tap clone → upgrade → assert version
#   release-verify.sh 0.4.44 --verify-only   # assert only: no upgrade, no reset --hard
#   release-verify.sh 0.4.44 --no-upgrade    # alias of --verify-only (failures-ledger 10.5)
#
# Every run appends per-Mac install evidence to the release receipt, so a
# release's fleet-wide state is a file, not four terminals' scrollback.
set -euo pipefail

die() { echo "release-verify: $*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECEIPT_CLI="$REPO_DIR/scripts/release-receipt.mjs"

VERSION="${1:-}"
VERIFY_ONLY=0
for arg in "${@:2}"; do
  case "$arg" in
    # --no-upgrade is the name failures-ledger row 10.5 asked for; keep both.
    --verify-only|--no-upgrade) VERIFY_ONLY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[ -n "$VERSION" ] || die "usage: release-verify.sh <X.Y.Z> [--verify-only|--no-upgrade]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be semver X.Y.Z, got '$VERSION'"
command -v brew >/dev/null 2>&1 || die "brew is not installed"

MODE="upgrade"
[ "$VERIFY_ONLY" -eq 1 ] && MODE="verify-only"

# Receipt writes never gate verification; they record it.
receipt() { node "$RECEIPT_CLI" "$@" >/dev/null || echo "release-verify: receipt write failed: $*" >&2; }
receipt_record() { receipt record "$VERSION" "$1" "$2"; }

receipt init "$VERSION"
receipt_record "verify.mode" "$MODE"

BREW_TAP_DIR="$(brew --repository)/Library/Taps/etanhey/homebrew-layers"
[ -d "$BREW_TAP_DIR/.git" ] || die "Homebrew tap clone not found at $BREW_TAP_DIR"
receipt_record "verify.tap_clone" "$BREW_TAP_DIR"

if [ "$VERIFY_ONLY" -eq 1 ]; then
  # Verify-only must never mutate this Mac: no reset --hard of brew's clone and
  # no `brew upgrade` (failures-ledger row 10.5 — a "verification" that upgrades
  # mid-fleet can break an explicit operator hold). Fetching only moves remote
  # refs, so the divergence can still be reported as evidence.
  git -C "$BREW_TAP_DIR" fetch origin
  BEHIND="$(git -C "$BREW_TAP_DIR" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)"
  receipt_record "verify.tap_clone_behind" "$BEHIND"
  if [ "$BEHIND" != "0" ] && [ "$BEHIND" != "unknown" ]; then
    echo "release-verify: NOTE — brew's tap clone is $BEHIND commit(s) behind origin/main (not synced in verify-only mode)"
  fi
else
  git -C "$BREW_TAP_DIR" fetch origin
  git -C "$BREW_TAP_DIR" reset --hard origin/main
  # measured after the sync, not asserted
  receipt_record "verify.tap_clone_behind" \
    "$(git -C "$BREW_TAP_DIR" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)"
  brew upgrade etanhey/layers/cmuxlayer
fi

INSTALLED="$(brew list --versions cmuxlayer || true)"
if [ "$INSTALLED" = "cmuxlayer $VERSION" ]; then
  receipt_record "verify.result" "pass"
  receipt install "$VERSION" --result pass --installed "$INSTALLED" --mode "$MODE"
  if "$REPO_DIR/scripts/post-release-reconnect-sweep.sh"; then
    receipt_record "verify.reconnect_sweep" "ran"
  else
    receipt_record "verify.reconnect_sweep" "failed"
    die "post-release reconnect sweep failed"
  fi
  echo "release-verify: cmuxlayer $VERSION is installed ($MODE mode); evidence appended to $(node "$RECEIPT_CLI" path "$VERSION")"
else
  receipt_record "verify.result" "fail"
  receipt install "$VERSION" --result fail --installed "${INSTALLED:-not installed}" --mode "$MODE"
  die "expected cmuxlayer $VERSION, got '${INSTALLED:-not installed}'"
fi
