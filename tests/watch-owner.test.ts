import { describe, expect, it } from "vitest";
import {
  resolveWatchOwnerFromSources,
  watchNotificationOwner,
  watchRecordOwner,
  type WatchOwnerCandidate,
} from "../src/watch-owner.js";

describe("watch owner source parity", () => {
  const candidate = (
    agent_id: string,
    seat_id?: string,
  ): WatchOwnerCandidate => ({ agent_id, seat_id });

  it.each([
    {
      shape: "canonical",
      owner: "lead-canonical",
      registry: [candidate("lead-canonical", "lead-seat")],
      states: [],
      kind: "resolved",
      ids: ["lead-canonical"],
    },
    {
      shape: "seat alias",
      owner: "lead-seat",
      registry: [candidate("lead-canonical", "lead-seat")],
      states: [],
      kind: "resolved",
      ids: ["lead-canonical"],
    },
    {
      shape: "unique prefix",
      owner: "lead",
      registry: [candidate("lead-unique")],
      states: [],
      kind: "resolved",
      ids: ["lead-unique"],
    },
    {
      shape: "ambiguous alias",
      owner: "lead-seat",
      registry: [candidate("lead-one", "lead-seat")],
      states: [candidate("lead-two", "lead-seat")],
      kind: "ambiguous",
      ids: ["lead-one", "lead-two"],
    },
    {
      shape: "registry-dead but state-live alias",
      owner: "lead-seat",
      registry: [candidate("lead-dead", "lead-seat")],
      states: [candidate("lead-live", "lead-seat")],
      kind: "ambiguous",
      ids: ["lead-dead", "lead-live"],
    },
    {
      shape: "absent",
      owner: "missing-seat",
      registry: [candidate("lead-one", "lead-seat")],
      states: [candidate("lead-two", "lead-seat")],
      kind: "unresolved",
      ids: [],
    },
  ])(
    "gives prune and delivery identical $shape resolution",
    ({ owner, registry, states, kind, ids }) => {
      const pruneResolution = resolveWatchOwnerFromSources(
        watchRecordOwner({ owner }),
        registry,
        states,
      );
      const deliveryResolution = resolveWatchOwnerFromSources(
        watchNotificationOwner({ owner }),
        registry,
        states,
      );
      const summary = (resolution: typeof pruneResolution) => ({
        kind: resolution.kind,
        ids: resolution.candidates.map(({ agent_id }) => agent_id),
      });

      expect(summary(pruneResolution)).toEqual(summary(deliveryResolution));
      expect(summary(pruneResolution)).toEqual({ kind, ids });
    },
  );
});
