#!/usr/bin/env bash
# Guard: no NEW docs.local/ path may ever become TRACKED by git.
#
# Why this exists (2026-09-01):
#   docs.local/ held verbatim speech-to-text dictation transcripts and desktop
#   screenshots containing session transcripts, personal workspace names, local
#   paths and private financial figures. Seven such blobs reached a public repo
#   and forced a full history rewrite plus a repo rebuild.
#
#   .gitignore did NOT prevent it. `git add -f` overrides .gitignore, and once a
#   path is tracked, .gitignore is ignored for that path forever after.
#   This guard is the part that actually holds.
#
# Two modes, chosen automatically:
#
#   No .docslocal-baseline file (or it is empty)
#     -> STRICT. Any tracked docs.local path fails. Use in repos at zero.
#
#   .docslocal-baseline present and non-empty
#     -> BASELINE. Paths listed there are pre-existing debt: reported as a
#        WARNING, exit 0. Any path NOT in the baseline is a new addition and
#        FAILS. Use in repos that still carry tracked docs.local files and whose
#        own lane will do the backed-up untrack later.
#
#   Regenerate the baseline ONLY when deliberately accepting current state:
#     git ls-files -- ':(glob)**/docs.local' ':(glob)**/docs.local/**' | LC_ALL=C sort > .docslocal-baseline
#
# Exit 0 = clean (or pre-existing debt only). Exit 1 = a new tracked path.

set -uo pipefail

fail() { echo "docs.local guard: $*" >&2; exit 1; }
root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git repository"
cd "$root" || fail "cannot enter git repository root"

# Git pathspecs match the component at any depth, including the root.
paths=(':(glob)**/docs.local' ':(glob)**/docs.local/**')
history=""
if [ "$#" -ne 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = --range ] || fail "usage: $0 [--range <base>..<head>]"
  range="$2"
  [[ "$range" == *..* && "$range" != *...* ]] || fail "expected <base>..<head>"
  base="${range%%..*}"; head="${range#*..}"
  git rev-parse --verify --end-of-options "$head^{commit}" >/dev/null 2>&1 || fail "invalid range head"
  if [[ -n "$base" && ! "$base" =~ ^0+$ ]] \
    && git rev-parse --verify --end-of-options "$base^{commit}" >/dev/null 2>&1 \
    && git merge-base --is-ancestor "$base" "$head"; then
    range="$base..$head"
  else
    echo "docs.local guard: no usable range base; scanning full history" >&2
    range="$head" # Initial/force push: every reachable commit, including the root.
  fi
  # -m includes additions relative to merge parents; no rename detection hides a move in.
  history="$(git log --full-history --root -m --format= --name-only --diff-filter=A --no-renames "$range" -- "${paths[@]}")" || fail "cannot scan commit range"
fi

BASELINE_FILE=".docslocal-baseline"

index="$(git ls-files -- "${paths[@]}")" || fail "cannot scan git index"
tracked="$(printf '%s\n%s\n' "$index" "$history" | sed '/^$/d' | LC_ALL=C sort -u)"

if [ -z "$tracked" ]; then
  echo "docs.local guard: OK — 0 tracked or range-added paths"
  exit 0
fi

tracked_count="$(printf '%s\n' "$tracked" | grep -c . || true)"

if [ -s "$BASELINE_FILE" ]; then
  baseline="$(grep -v '^[[:space:]]*#' "$BASELINE_FILE" | grep . | LC_ALL=C sort || true)"
else
  baseline=""
fi

# Paths tracked now that are NOT in the baseline = new additions.
new_paths="$(LC_ALL=C comm -23 \
  <(printf '%s\n' "$tracked") \
  <(printf '%s\n' "$baseline") 2>/dev/null || printf '%s\n' "$tracked")"
new_paths="$(printf '%s\n' "$new_paths" | grep . || true)"

if [ -n "$new_paths" ]; then
  new_count="$(printf '%s\n' "$new_paths" | grep -c . || true)"
  cat <<BANNER

BLOCKED — $new_count NEW docs.local path(s) tracked or added in commit range.

docs.local/ is local-only scratch. It has previously contained dictation
transcripts and desktop screenshots with personal data. Tracked files here get
published the moment the repo is public, or the moment someone forks it.

New tracked or range-added paths:
BANNER
  printf '%s\n' "$new_paths" | sed 's/^/  /'
  cat <<'BANNER'

For range findings, remove the additions from the unpublished commits first;
a later deletion does not remove published history.

For index findings (this removes them from git, NOT from your disk):

  git rm -r --cached <path>

WARNING — read before you merge any docs.local untracking:
  `git rm --cached` keeps the files only in the worktree that ran it.
  EVERY other checkout that pulls the merge gets those paths DELETED from
  its working tree. Back up first, outside git:

  cp -a docs.local ~/backups/$(basename "$PWD")-docs.local-$(date +%Y-%m-%d)/

  If a checkout already lost them, restore with:

  git checkout <merge-sha>^1 -- docs.local/ && git reset HEAD docs.local/

  After merging, check EVERY checkout (`git worktree list`), not just this one.

Do not bypass with --no-verify.

BANNER
  exit 1
fi

# Everything tracked is pre-existing, accepted debt.
cat <<BANNER
docs.local guard: WARNING — $tracked_count tracked path(s), all pre-existing.

These are known debt recorded in $BASELINE_FILE. They are NOT failing this
check, so this repo's own lane can do the backed-up untrack on its own
schedule (back up docs.local outside git first, then verify EVERY checkout).

New docs.local paths WILL fail this check.
BANNER
exit 0
