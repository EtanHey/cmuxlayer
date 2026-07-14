import { describe, expect, it } from "vitest";
import {
  assertSeatIdentity,
  type SeatRegistry,
} from "../src/seat-identity.js";

describe("seat identity uniqueness", () => {
  it("does not turn an ambiguous launcher class into the first declared seat", () => {
    const registry: SeatRegistry = {
      cmuxlayerLead: {
        repo: "cmuxlayer",
        launchers: { codex: "cmuxlayerCodex" },
        lane: "cmuxlayer",
        role: "lead",
      },
      cmuxlayerWorker: {
        repo: "cmuxlayer",
        launchers: { codex: "cmuxlayerCodex" },
        lane: "cmuxlayer",
        role: "worker",
      },
    };

    expect(
      assertSeatIdentity({
        repo: "cmuxlayer",
        cli: "codex",
        launcherName: "cmuxlayerCodex",
        registry,
      }),
    ).toEqual({
      seat_id: null,
      seat_lane: null,
      seat_role: null,
      seat_identity_status: "unknown",
      seat_identity_error:
        "ambiguous seat registry match for repo=cmuxlayer launcher=cmuxlayerCodex: cmuxlayerLead, cmuxlayerWorker",
    });
  });

  it("does not turn ambiguous launcher ownership into the first mismatched seat", () => {
    const registry: SeatRegistry = {
      alphaWorker: {
        repo: "alpha",
        launchers: { codex: "sharedCodex" },
        lane: "alpha",
        role: "worker",
      },
      betaWorker: {
        repo: "beta",
        launchers: { codex: "sharedCodex" },
        lane: "beta",
        role: "worker",
      },
    };

    expect(
      assertSeatIdentity({
        repo: "gamma",
        cli: "codex",
        launcherName: "sharedCodex",
        registry,
      }),
    ).toEqual({
      seat_id: null,
      seat_lane: null,
      seat_role: null,
      seat_identity_status: "unknown",
      seat_identity_error:
        "ambiguous seat registry match for launcher=sharedCodex: alphaWorker, betaWorker",
    });
  });

  it("does not turn an unmatched launcher in an ambiguous repo into the first seat", () => {
    const registry: SeatRegistry = {
      cmuxlayerLead: {
        repo: "cmuxlayer",
        launchers: { codex: "cmuxlayerLeadCodex" },
        lane: "cmuxlayer",
        role: "lead",
      },
      cmuxlayerWorker: {
        repo: "cmuxlayer",
        launchers: { codex: "cmuxlayerWorkerCodex" },
        lane: "cmuxlayer",
        role: "worker",
      },
    };

    expect(
      assertSeatIdentity({
        repo: "cmuxlayer",
        cli: "codex",
        launcherName: "staleCodex",
        registry,
      }),
    ).toEqual({
      seat_id: null,
      seat_lane: null,
      seat_role: null,
      seat_identity_status: "unknown",
      seat_identity_error:
        "ambiguous seat registry repo match for repo=cmuxlayer launcher=staleCodex: cmuxlayerLead, cmuxlayerWorker",
    });
  });
});
