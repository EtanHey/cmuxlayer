# D82 Boot Delivery Design

## Goal

Make boot-prompt delivery wait for a real idle agent turn, report a bounded banner-independent queue honestly, reject interrupt-rescued transcript echoes as verified submission, and preserve the live agent binding when delivery does not complete.

## Chosen approach

`waitForBootPromptReady` remains the single pre-delivery gate, but a working or thinking agent is no longer writable merely because its composer chrome and identity are visible. The gate waits until the same agent route has an idle/done composer. If its deadline expires while the agent is still working with an empty composer and no prompt echo, it returns an observed queued result instead of throwing or typing into the running turn.

`deliverBootPrompt` converts that result into an explicit `delivery_state: "queued"` receipt with no typing or Return attempt. Managed spawn handlers retain `boot_prompt_pending` for this state, so the live pane stays registered and inspectable. Lifecycle reconciliation is not allowed to infer `prompt_delivered` or `submit_verified` from a ready/active screen when the server has recorded that the prompt was not delivered.

Post-Return verification compares interrupt markers against the pre-Return screen. A new `Conversation interrupted` marker followed by transcript echo produces terminal `delivery_state: "rescued"`, `delivered: false`, and `submit_verified: false`; it can never produce a verified receipt.

## Rejected approaches

- Send while the front-matter turn is running and infer the hidden queue later: this repeats the defect and depends on Codex queue rendering.
- Press Escape before sending: the live probe showed that Escape kills the active turn and can create a false-green transcript receipt.
- Treat a working/status frame as submission evidence: it is not attributable to the boot prompt.

## Verification

Tests must fail first for idle-wait delivery, bounded bannerless queueing, interrupt rescue, and registry retention. Focused tests cover receipt vocabulary and lifecycle reconciliation. Completion additionally requires the full suite, typecheck with and without inherited environment, local review, exact-head CI, and the lead-owned front-matter live probe plus AFTER recording.
