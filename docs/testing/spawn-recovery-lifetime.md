# Owned boot recovery lifetime ratchet

These rows replay conditional completion loss through the real SDK/MCP protocol
with a deterministic fake pane and deferred transport/read barriers. They make no
model, authentication, provider or native cmux calls and do not establish an
ordinary installed-client incident.

Run the focused rows under the repository's shared suite admission procedure:

```sh
bunx vitest run --maxWorkers=1 tests/spawn-contract-once.test.ts -t 'Post-dispatch recovery lifetime'
```

Bug source: `bc5433c82f89fac4284890b7b3f8219513a2a78b`. The correction's exact
source and test identities are sealed with its local commit in the lane receipt.
The committed tests run in the ordinary suite too. Parameterized test names use
`<fault> during awaited <Return|verification> preserves truthful completion and never replays`.

| Row | Fault at an actual awaited boundary | Required outcome |
| --- | --- | --- |
| recovery-return-disposed | Dispose the owning context during Return transport | Return acknowledged, completion unknown; original receipt stays pending |
| recovery-return-missing | Delete and persist removal of the original queue receipt during Return | No throw, invented receipt, boot settlement or replay |
| recovery-return-replacement | Install a different real synthetic engine, with a conflicting same-ID receipt, during Return | No replacement engine mutation or original boot settlement |
| recovery-return-receipt-replaced | Change the original ID's receipt owner/text during Return | Conflicting receipt unchanged; submission remains unverified |
| recovery-verify-disposed | Dispose context during the verification read | Positive pane text cannot settle the original boot |
| recovery-verify-missing | Remove and persist the original receipt during verification | No recreation or completion claim |
| recovery-verify-replacement | Replace the engine during verification | No registry/receipt write into the replacement |
| recovery-verify-receipt-replaced | Replace the receipt owner/text during verification | No conflicting receipt update or verified result |
| recovery-stable-control | Keep the engine and original receipt stable through Return | Original ID/context settles once from attributable evidence |

Every loss row checks `submit_dispatched:true` for the acknowledged Return,
`submit_verified:null`, `submitted:false`, `delivered:false`, `terminal:false`,
an explicit unverified warning, unchanged pending boot state, one Return and one
original input. Disposal/replacement preserve the original receipt's ownership
and captured baseline; missing receipts remain absent. Conflicting receipts and
replacement registries must be unchanged. The stable control must pass.

Private source contrasts use identical tests and all other source bytes:

- Exact bug source: eight loss rows fail, stable control passes.
- Corrected source: all nine pass.
- Corrected source with only the final ownership recheck reversed: four
  verification rows fail; the four Return rows and stable control pass.

Companion focused verification retains the existing uncertain-ACK/no-replay,
original-ID settlement, captured-null baseline, legacy baseline, caller/boot/
session ownership and complete payload controls. Native verification and scoped
source review remain separate gates before publication.
