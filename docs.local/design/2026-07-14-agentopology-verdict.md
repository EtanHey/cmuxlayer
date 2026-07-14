# AgentOpology verdict for seat-binding correctness

**Verdict: ADAPT the declarative pattern; reject AgentOpology as runtime authority.**

## Why

AgentOpology is a compile-time `.at` language and scaffold generator. Its binding
contract emits files; it has no live cmux instance ledger, surface UUID/ref
resolution, screen observation, focus route, lifecycle tombstone, or
reconciliation API. The existing ecosystem evaluation likewise limits its fit to
static configuration rather than cmux runtime control.

cmuxlayer already receives the runtime primitive that AgentOpology lacks:
`CmuxSurface.id`, the stable UUID for one surface lifetime. Before this fix that
value was discarded while the recyclable `surface:N` ref was persisted and
reused as all of the following:

- registry identity;
- screen-read target;
- sidebar deduplication key;
- displayed title/seat join;
- click-focus argument.

That invalid join explains the three reported symptoms together. A stale or
wrong-but-live ref reads another surface's state, renders its labels under the
wrong registry record, and focuses an unknown or foreign handle. The ref is a
routing alias, not a primary key.

Static seat policy is also non-injective. The live configuration gives
`cmuxlayerLead` and `cmuxlayerClaude` the same repo/lane/launcher signature (and
does the same for other lanes). `assertSeatIdentity()` currently selects the
first match and reports it as authoritative. A declarative file cannot repair
that ambiguity unless the schema validates uniqueness or the caller supplies an
explicit seat instance.

## Runtime invariant

Every rendered row must satisfy all of these conditions:

1. One `surface_uuid` identifies the immutable live surface instance.
2. The row identity, title, screen state, status, and current ref come from the
   same UUID-bound topology observation.
3. `surface_ref` is only the current routing/debug alias.
4. Focus uses the stable UUID; an unresolved UUID never falls through to a stale
   ref.
5. Two surfaces with identical launcher/title classes remain two distinct
   runtime instances.
6. Empty, incomplete, mixed-identity, contradictory, or first-missing topology
   observations are non-destructive.
7. Ambiguous static seat signatures produce `unknown`, never a first-match
   identity.
8. A runtime instance may mutate only records it owns; a healthy production
   observer cannot turn another cmux instance's seats into errors.
9. Every agent-addressed terminal read or mutation resolves the UUID against a
   fresh topology observation immediately before I/O, so a recycled ref cannot
   supply evidence or receive a stale message.

## Implemented scope

This PR makes the runtime migration additive:

- request `--id-format both` on every CLI call and preserve the UUID returned by
  cmux surface creation;
- carry `surface_uuid` through discovery, state, registry repair, topology, seat
  manifests, and Fleet candidates;
- resolve a persisted UUID to the current ref before screen parsing;
- deduplicate and focus Fleet rows by UUID;
- suppress a record whose UUID is no longer present instead of rendering a
  false identity;
- make disappearance transitions use the same confirmation window as eviction;
- scope destructive reconciliation by the current cmux observer/socket;
- derive persisted observer ownership from the Unix socket node identity and
  keep transient connection/self-heal generations in a separate in-flight
  epoch, so a cmux restart that reuses the same pathname cannot inherit a
  previous instance's UUID-less seats;
- preserve the last authoritative Fleet snapshot when topology is empty,
  incomplete (including a successful but truncated pane enumeration),
  contradictory, or has mixed UUID coverage;
- validate UUID↔ref evidence as one case-insensitive bijection and reject the
  whole contradictory component instead of accepting a convenient partial map;
- centralize fresh UUID routing for lifecycle delivery, stop/send, boot/session
  evidence, resync, health, auto-compact, and app-server
  send/read/interrupt operations;
- allow UUID-less compatibility I/O only for a current owned observer and a
  complete all-ref topology; mixed or recycled-ref observations fail closed;
- quarantine active pre-upgrade records whose cmux observer cannot be proven,
  while allowing topology-independent cleanup of terminal legacy history;
- key discovery and lifecycle caches by the live observer, and pin placement,
  role-based split, stop/collapse policy, and topology reads to one observer
  epoch so reconnects cannot turn an old observation into a new-instance
  mutation;
- apply manual-mode mutation authorization to the freshly resolved moved-UUID
  route immediately before stop/kill side effects;
- reject ambiguous static seat matches;
- cover first-click, state, identity, ref-recycling, observer isolation, and
  degraded-topology behavior with a sanitized real-capture fixture and UI
  screenshot from the July 14 round-5 topology.

The live first-click acceptance is recorded in
`docs.local/artifacts/2026-07-14-seat-binding-first-click-receipt.json`: a
validated native Swift row was clicked while focused on another surface, and
`cmux tree --all --id-format both` changed to the row's stable UUID and current
ref on that first click, without terminal activity.

Owned legacy records without a UUID retain ref compatibility. Active unowned
legacy records remain quarantined because neither a UUID nor an observer exists
to prove which cmux instance owns the recyclable ref. New managed and discovered
records receive observer ownership immediately and are UUID-backed whenever cmux
reports stable identity.

## Future AgentOpology adaptation

A later migration may represent **static** seat classes in an `.at`-inspired
schema and generate/validate the local seat registry. That schema should require
unique keys or explicit instance IDs and may emit role/lane/launcher policy.
It must not emit or own live UUIDs, refs, parsed state, focus routes, or
lifecycle truth, and it must stay off the first-render critical path.

Full AgentOpology adoption is rejected for this bug: it would add a compiler,
custom binding, generated-schema reader, and migration while cmuxlayer would
still need the UUID runtime ledger described above.
