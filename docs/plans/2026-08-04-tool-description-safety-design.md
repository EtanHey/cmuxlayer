# Tool Description Safety Design

## Context

Pane-input guards already reject oversized and dense inline payloads, but their
human-facing descriptions emphasize byte thresholds and an override. That
framing invites callers to split or override long prose even though long inline
delivery can wedge the receiving composer. The product rule must be stated in
the tool descriptions that govern pane writes.

`list_surfaces` is already condensed by default. A live 11-surface measurement
returned 3,779 structured bytes in condensed mode and 9,262 structured bytes in
verbose mode (2.45 times larger). The condensed fields beyond the original four
identify panes, columns, and real working directories; they were added for
deterministic placement and routing and should remain.

## Approaches considered

1. **Central safety wording in every pane-writing description (chosen).** Put
   the same harm-first warning at the front of each applicable tool and payload
   field description. Keep the numeric schema guards unchanged. This is the
   smallest change and prevents wording drift.
2. **Repeat custom warnings per tool.** This can tailor prose, but creates more
   opportunities for one alias or nested prompt field to regress.
3. **Replace the byte guard with a hard two-to-three-line guard.** This changes
   runtime behavior beyond the ruling and would reject valid short commands or
   deliberately guarded raw sends.

## Design

- Replace the threshold-led shared guidance with harm-first wording: maximum
  two to three short lines; longer payloads break the receiving pane; write the
  payload to a file and send one `Read and follow <path>` line.
- Lead every pane-writing tool description with that guidance: `send_to`,
  `send_input`, `send_command`, `broadcast`, `spawn_agent`, `new_split`,
  `new_surface`, `new_worktree_split`, `spawn_in_workspace`, and the deprecated
  `send_to_agent` alias.
- Lead text/command/prompt field descriptions with the same warning where an
  inline payload exists. `new_split` has no inline `prompt` field on this base;
  its tool description and file-backed `boot_prompt_path` description will
  carry the rule without inventing a new unsafe input.
- Preserve `CMUXLAYER_MAX_INLINE_CHARS`, dense-line guards, and
  `allow_long_inline` behavior as machine-enforced compatibility controls.
  A review-time RED exposed that the deprecated `new_worktree_split` and
  `spawn_in_workspace` prompt paths did not invoke those guards. Route all
  three spawn APIs through one pre-mutation prompt validator; the deprecated
  paths have no raw-inline override and must use file-backed delivery.
- Keep `list_surfaces` condensed fields unchanged. Update the tool and
  `verbose` argument descriptions to state that verbose returns every raw cmux
  field, materially increases token usage, and is rarely needed.

## `submit_verified` recommendation

Do not blanket-fail `submit_verified:null`. On current `main`, normal
interactive `send_to` delivery attempts verification; an attempted but
unconfirmed submission becomes `false` and returns non-ok. A successful `null`
means verification was intentionally not attempted, such as `press_enter:false`
or `allow_busy:true`. PR #326 hardens the complementary spawn/boot settlement
path; it does not replace generic relay handling already present from #343.

## Verification

- Regression-test all applicable tool and field descriptions.
- Regression-test that every spawn prompt path rejects over-cap, dense, and
  multi-paragraph inline prompts before pane/workspace mutation.
- Verify the description tests fail before production changes and pass after.
- Run the targeted Vitest files, typecheck, build, pre-PR harness, and the full
  Vitest suite under an isolated `TMPDIR`.
- Exercise the built MCP binary through a real stdio client, list the served
  tools, and call `list_surfaces` in both modes.
