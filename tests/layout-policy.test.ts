import { describe, expect, it } from "vitest";
import {
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  inferAgentRole,
  launcherNameForCli,
} from "../src/layout-policy.js";
import type { CmuxPane, CmuxPaneSurfaces, CmuxSurface } from "../src/types.js";

function makePane(
  ref: string,
  index: number,
  surfaceRefs: string[],
): CmuxPane {
  return {
    ref,
    index,
    focused: index === 0,
    surface_count: surfaceRefs.length,
    surface_refs: surfaceRefs,
    selected_surface_ref: surfaceRefs[0],
  };
}

function makeSurface(ref: string, index: number): CmuxSurface {
  return {
    ref,
    title: "",
    type: "terminal",
    index,
    selected: index === 0,
  };
}

function makePaneSurfaces(
  pane: string,
  surfaceRefs: string[],
): CmuxPaneSurfaces {
  return {
    workspace_ref: "ws:1",
    window_ref: "window:1",
    pane_ref: pane,
    surfaces: surfaceRefs.map((ref, index) => makeSurface(ref, index)),
  };
}

describe("layout policy", () => {
  it("infers default role from repoGolem launcher names", () => {
    expect(inferAgentRole({ launcherName: "orcClaude" })).toBe(
      "orchestrator",
    );
    expect(inferAgentRole({ launcherName: "cmuxlayerCodex" })).toBe("worker");
    expect(inferAgentRole({ launcherName: "brainlayerCursor" })).toBe(
      "worker",
    );
  });

  it("lets an explicit role override launcher inference", () => {
    expect(
      inferAgentRole({ launcherName: "skillcreatorClaude", role: "ic" }),
    ).toBe("ic");
  });

  it("does not let repo names that end with launcher suffixes affect non-launcher CLIs", () => {
    expect(
      inferAgentRole({
        launcherName: launcherNameForCli("apiClaude", "gemini"),
        cli: "gemini",
      }),
    ).toBe("worker");
  });

  it("places orchestrators as tabs in the left orchestrator pane", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:orc"]),
      makePane("pane:right", 1, ["surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orc"]),
      makePaneSurfaces("pane:right", ["surface:worker-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orc"]),
        ic: new Set(),
        worker: new Set(["surface:worker-1"]),
      },
      { role: "orchestrator" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:left" });
  });

  it("places the first IC in the right column above existing workers", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:orc"]),
      makePane("pane:right", 1, ["surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orc"]),
      makePaneSurfaces("pane:right", ["surface:worker-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orc"]),
        ic: new Set(),
        worker: new Set(["surface:worker-1"]),
      },
      { role: "ic" },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "up",
      pane: "pane:right",
    });
  });

  it("places the first worker under its parent IC", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:orc"]),
      makePane("pane:ic", 1, ["surface:ic"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orc"]),
      makePaneSurfaces("pane:ic", ["surface:ic"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orc"]),
        ic: new Set(["surface:ic"]),
        worker: new Set(),
      },
      {
        role: "worker",
        parentRole: "ic",
        parentSurfaceId: "surface:ic",
        childWorkerSurfaceIds: new Set(),
      },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "down",
      pane: "pane:ic",
    });
  });

  it("reuses an existing worker pane under the parent IC for sibling workers", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:orc"]),
      makePane("pane:ic", 1, ["surface:ic"]),
      makePane("pane:children", 2, ["surface:child-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orc"]),
      makePaneSurfaces("pane:ic", ["surface:ic"]),
      makePaneSurfaces("pane:children", ["surface:child-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orc"]),
        ic: new Set(["surface:ic"]),
        worker: new Set(["surface:child-1"]),
      },
      {
        role: "worker",
        parentRole: "ic",
        parentSurfaceId: "surface:ic",
        childWorkerSurfaceIds: new Set(["surface:child-1"]),
      },
    );

    expect(placement).toEqual({
      kind: "surface",
      pane: "pane:children",
    });
  });

  it("creates a fresh right split when the only existing worker shares a pane with interactive surfaces", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:interactive", "surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:interactive", "surface:worker-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1"]),
    );

    expect(placement).toEqual({ kind: "split", direction: "right" });
  });

  it("reuses the rightmost dedicated worker pane for subsequent workers", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:interactive"]),
      makePane("pane:right", 1, ["surface:worker-1", "surface:worker-2"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:interactive"]),
      makePaneSurfaces("pane:right", ["surface:worker-1", "surface:worker-2"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1", "surface:worker-2"]),
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
  });

  it("marks a dedicated single-worker pane as collapsible when its last tab closes", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:interactive"]),
      makePane("pane:right", 1, ["surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:interactive"]),
      makePaneSurfaces("pane:right", ["surface:worker-1"]),
    ];

    const policy = chooseSurfaceClosePolicy(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1"]),
      "surface:worker-1",
    );

    expect(policy).toEqual({
      surface: "surface:worker-1",
      pane: "pane:right",
      collapsePane: true,
    });
  });

  it("does not mark mixed panes as collapsible worker panes", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:interactive", "surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:interactive", "surface:worker-1"]),
    ];

    const policy = chooseSurfaceClosePolicy(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1"]),
      "surface:worker-1",
    );

    expect(policy).toEqual({
      surface: "surface:worker-1",
      pane: "pane:left",
      collapsePane: false,
    });
  });

  it("does not collapse when closing a non-worker surface while a dedicated worker pane exists elsewhere", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:interactive"]),
      makePane("pane:right", 1, ["surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:interactive"]),
      makePaneSurfaces("pane:right", ["surface:worker-1"]),
    ];

    const policy = chooseSurfaceClosePolicy(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1"]),
      "surface:interactive",
    );

    expect(policy).toEqual({
      surface: "surface:interactive",
      pane: "pane:left",
      collapsePane: false,
    });
  });

  it("does not claim collapse semantics when no surfaces are classified as workers", () => {
    const panes = [makePane("pane:left", 0, ["surface:interactive"])];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:interactive"]),
    ];

    const policy = chooseSurfaceClosePolicy(
      panes,
      paneSurfaces,
      new Set(),
      "surface:interactive",
    );

    expect(policy).toEqual({
      surface: "surface:interactive",
      pane: "pane:left",
      collapsePane: false,
    });
  });

  it("reuses the rightmost dedicated worker pane when multiple worker panes exist", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:interactive"]),
      makePane("pane:right", 1, ["surface:worker-1"]),
      makePane("pane:rightmost", 2, ["surface:worker-2"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:interactive"]),
      makePaneSurfaces("pane:right", ["surface:worker-1"]),
      makePaneSurfaces("pane:rightmost", ["surface:worker-2"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1", "surface:worker-2"]),
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:rightmost" });
  });
});
