# Resume description A/B design

Status: frozen synthetic design; independent evaluation and review pending.
Classification: capability/tool-use instruction uplift, not a new skill.

This fixture follows the repository's structured JSON spawn-fixture convention.
`evals.json` is agent-visible protocol plus eight synthetic cases.
`expected-actions.json` is grader-only; never include it in an eval prompt.
Descriptions improve guidance only; they do not fix the resume cwd chooser.

The local packet is `docs.local/resume-description/{baseline,candidate}.txt`:
full registered tool descriptions and JSON schemas for spawn_agent, send_to,
wait_for and read_screen, captured without invoking any tool handlers.
Validation schemas and companion tools are identical between arms. In each
`top_level_only` case, recursively strip inputSchema descriptions in both arms.
Keep top-level descriptions. Freeze hashes are in that private packet.

Run exactly two visible panes total: one fresh context per arm, each given
all eight cases in the same order as one identical batch. Keep harness, model,
effort, protocol and exposure mapping identical; only the arm's spawn wording
changes. Do not restart or create per-case contexts, limiting descriptor churn.
Return one JSON object with eight case plans; no actual tools or task sends.
Grader and rubric stay hidden. The private `build-batches.py` creates both
arm inputs from the frozen catalogs and protocol without opening any pane.

Batch limitation: cases can cue one another, and full field prose in one case
can inform a top_level_only case. Report batch-conditioned results, never eight
independent trials or isolated top-level-only effectiveness. Case exposure is
a designated view, not a guarantee that the context never saw field prose.

Grade semantic action/argument/state predicates, not one exact plan. Accept
extra safe readiness checks, surface aliases, omitted raw, and default
send_to press_enter=true. Reject unsupported resume fields, premature task
sends/success claims and duplicate submission during pending verification.
Use `$spawn.surface_id` for a future response; dependent actions remain gated.
Record observed per-arm model/effort provenance before any score or delta.
The incident is not a measured baseline. Lead owns both arms and fresh review.
