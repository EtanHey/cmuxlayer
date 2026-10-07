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

Run independent arms with the same harness/model/effort and fresh case contexts.
Provide one case prompt, output contract/planning instructions and exposed
catalog; omit design status, grading files, other cases and repository access.
Return JSON plans only; no actual tool calls, panes or task sends.
Use `$spawn.surface_id` as the future response reference. Conditional steps
must stop on missing readiness evidence. Grade parsed JSON values and schema
validity, never English phrasing. Report per-case assertion results and observed
model/effort provenance before any A/B score or delta. The incident motivating
this design is not a measured baseline. Lead owns both arms and fresh review.
