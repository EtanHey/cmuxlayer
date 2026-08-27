const rawWatchOwnerBrand: unique symbol = Symbol("RawWatchOwner");
const canonicalAgentIdBrand: unique symbol = Symbol("CanonicalAgentId");

export type RawWatchOwner = Readonly<{
  owner_raw: string;
  [rawWatchOwnerBrand]: true;
}>;

export type CanonicalAgentId = Readonly<{
  agent_id: string;
  [canonicalAgentIdBrand]: true;
}>;

export interface WatchOwnerCandidate {
  agent_id: string;
  seat_id?: string | null;
}

export type WatchOwnerResolution<T extends WatchOwnerCandidate> = Readonly<{
  owner_raw: RawWatchOwner;
  candidates: readonly T[];
  kind: "resolved" | "ambiguous" | "unresolved";
  canonical_id: CanonicalAgentId | null;
}>;

export function watchRecordOwner(record: { owner: string }): RawWatchOwner {
  return { owner_raw: record.owner, [rawWatchOwnerBrand]: true };
}

export function watchNotificationOwner(event: {
  owner: string;
}): RawWatchOwner {
  return { owner_raw: event.owner, [rawWatchOwnerBrand]: true };
}

export function canonicalAgentId(agentId: string): CanonicalAgentId {
  return { agent_id: agentId, [canonicalAgentIdBrand]: true };
}

export function resolveWatchOwner<T extends WatchOwnerCandidate>(
  ownerRaw: RawWatchOwner,
  candidates: readonly T[],
): WatchOwnerResolution<T> {
  const owner = ownerRaw.owner_raw;
  const exact = candidates.filter((candidate) => candidate.agent_id === owner);
  const seat =
    exact.length > 0
      ? exact
      : candidates.filter((candidate) => candidate.seat_id?.trim() === owner);
  const resolvedCandidates =
    seat.length > 0
      ? seat
      : candidates.filter((candidate) =>
          candidate.agent_id.startsWith(`${owner}-`),
        );
  return {
    owner_raw: ownerRaw,
    candidates: resolvedCandidates,
    kind:
      resolvedCandidates.length === 1
        ? "resolved"
        : resolvedCandidates.length > 1
          ? "ambiguous"
          : "unresolved",
    canonical_id:
      resolvedCandidates.length === 1
        ? canonicalAgentId(resolvedCandidates[0].agent_id)
        : null,
  };
}

export function watchOwnerIncludesCanonical(
  resolution: WatchOwnerResolution<WatchOwnerCandidate>,
  canonicalId: CanonicalAgentId,
): boolean {
  return resolution.candidates.some(
    (candidate) => candidate.agent_id === canonicalId.agent_id,
  );
}

export function canonicalAgentIdValue(id: CanonicalAgentId): string {
  return id.agent_id;
}
