import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSeatIdentity,
  defaultSeatRegistryPath,
  loadSeatRegistryFromConfig,
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

describe("seat registry source", () => {
  it("lets the caller point the seat registry away from the machine's ~/.golems", () => {
    const pinned = join(tmpdir(), "cmuxlayer-seat-registry-fixture.yaml");

    expect(
      defaultSeatRegistryPath({ CMUXLAYER_SEAT_REGISTRY_PATH: pinned }),
    ).toBe(pinned);
    expect(defaultSeatRegistryPath({})).toBe(
      join(homedir(), ".golems", "config.yaml"),
    );
  });

  // The suite once asserted `brainClaude` — a seat that exists only in the
  // maintainer's ~/.golems/config.yaml. It was green on that Mac and red on
  // every CI runner for days. Tests state their own registry or get none.
  it("never resolves the seat registry from the machine running the suite", () => {
    const pinned = defaultSeatRegistryPath();

    expect(pinned).not.toBe(join(homedir(), ".golems", "config.yaml"));
    expect(existsSync(pinned)).toBe(false);
    expect(loadSeatRegistryFromConfig()).toBeNull();
  });
});
