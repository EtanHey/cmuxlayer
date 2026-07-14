import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFleetSidebarCommand } from "../src/fleet-sidebar-cli.js";
import { FleetSidebarCollapseStore } from "../src/fleet-sidebar.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-fleet-cli-"));
  tempDirs.push(root);
  const statePath = join(root, "fleet-collapse.json");
  const sidebarPath = join(root, "fleet.swift");
  return {
    statePath,
    sidebarPath,
    store: new FleetSidebarCollapseStore({ statePath }),
  };
}

describe("fleet-sidebar CLI fallback", () => {
  it("collapses and expands active lanes independently", () => {
    const { store, sidebarPath } = fixture();

    expect(
      runFleetSidebarCommand(["collapse", "skillCreator"], {
        store,
        sidebarPath,
      }),
    ).toEqual({
      ok: true,
      message: "skillCreator lane collapsed",
    });
    expect(
      runFleetSidebarCommand(["expand", "cmuxlayer"], {
        store,
        sidebarPath,
      }),
    ).toEqual({
      ok: true,
      message: "cmuxlayer lane expanded",
    });
    expect(store.read()).toEqual({
      skillCreator: true,
      cmuxlayer: false,
    });
  });

  it("normalizes the skill-creator lane spelling", () => {
    const { store, sidebarPath } = fixture();

    const result = runFleetSidebarCommand(["collapse", "skill-creator"], {
      store,
      sidebarPath,
    });

    expect(result.ok).toBe(true);
    expect(store.read()).toEqual({ skillCreator: true });
  });

  it("expands and collapses the mm lane", () => {
    const { store, sidebarPath } = fixture();

    expect(
      runFleetSidebarCommand(["expand", "mm"], { store, sidebarPath }),
    ).toEqual({ ok: true, message: "mm lane expanded" });
    expect(
      runFleetSidebarCommand(["collapse", "mm"], { store, sidebarPath }),
    ).toEqual({ ok: true, message: "mm lane collapsed" });
    expect(store.read()).toEqual({ mm: true });
  });

  it("toggles from the currently rendered state when no preference exists", () => {
    const { store, sidebarPath } = fixture();
    writeFileSync(
      sidebarPath,
      'fleetLane("orc", 1, 0, true, 1, [\n',
      "utf8",
    );

    const result = runFleetSidebarCommand(["toggle", "orc"], {
      store,
      sidebarPath,
    });

    expect(result).toEqual({ ok: true, message: "orc lane expanded" });
    expect(store.read()).toEqual({ orc: false });
  });

  it("reports persisted state without mutating it", () => {
    const { store, statePath, sidebarPath } = fixture();
    store.setLaneCollapsed("cmuxlayer", true);
    const before = readFileSync(statePath, "utf8");

    const result = runFleetSidebarCommand(["state"], {
      store,
      sidebarPath,
    });

    expect(result).toEqual({
      ok: true,
      message: JSON.stringify({ cmuxlayer: true }),
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("rejects unknown actions and lanes with concise usage", () => {
    const { store, sidebarPath } = fixture();

    expect(
      runFleetSidebarCommand(["collapse", "brainlayer"], {
        store,
        sidebarPath,
      }),
    ).toMatchObject({ ok: false });
    expect(
      runFleetSidebarCommand(["explode", "orc"], { store, sidebarPath }),
    ).toEqual({
      ok: false,
      message:
        "Usage: cmuxlayer fleet-sidebar <collapse|expand|toggle|state> [lane]",
    });
  });
});
