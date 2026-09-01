#!/usr/bin/env bash
# Guard: no docs.local/ path may ever be TRACKED by git.
#
# Why this exists (2026-09-01):
#   docs.local/ held verbatim speech-to-text dictation transcripts and desktop
#   screenshots containing personal data. Seven such blobs reached the public
#   repo and forced a full history rewrite plus a repo rebuild.
#
#   .gitignore did NOT prevent it. `git add -f` overrides .gitignore, and once a
#   path is tracked, .gitignore is ignored for that path forever after.
#   This guard is the part that actually holds.
#
# Exit 0 = clean. Exit 1 = tracked docs.local paths found.
#
# Used by: .githooks/pre-push and .github/workflows/ci.yml

set -uo pipefail

tracked="$(git ls-files -- 'docs.local' 'docs.local/**' 2>/dev/null || true)"

if [ -z "$tracked" ]; then
  echo "docs.local guard: OK — 0 tracked paths"
  exit 0
fi

count="$(printf '%s\n' "$tracked" | grep -c . || true)"

cat <<BANNER

BLOCKED — $count docs.local path(s) are TRACKED by git.

docs.local/ is local-only scratch. It has previously contained dictation
transcripts and screenshots with personal data. Tracked files here end up
published the moment this repo is public.

Tracked paths:
BANNER

printf '%s\n' "$tracked" | sed 's/^/  /'

cat <<'BANNER'

To fix (this removes them from git, NOT from your disk):

  git rm -r --cached docs.local
  git commit -m "chore: untrack docs.local"

WARNING — read before you merge that commit:
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
