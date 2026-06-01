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

  it("inferAgentRole never silently guesses worker", () => {
    expect(
      inferAgentRole({
        title: "skillcreatorClaude: publish 24h dashboard",
      }),
    ).toBe("orchestrator");

    expect(() => inferAgentRole({ title: "publish 24h dashboard" })).toThrow(
      /Unable to infer agent role/,
    );
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

  it("splits the first child worker to the right of its parent orchestrator pane", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"]),
      makePane("pane:notes", 1, ["surface:notes"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:notes", ["surface:notes"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(),
      },
      {
        role: "worker",
        parentRole: "orchestrator",
        parentSurfaceId: "surface:orchestrator",
        childWorkerSurfaceIds: new Set(),
      },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "right",
      pane: "pane:lead",
    });
  });

  it("reuses an existing worker pane beside the parent orchestrator for sibling workers", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"]),
      makePane("pane:children", 1, ["surface:child-1", "surface:child-2"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:children", ["surface:child-1", "surface:child-2"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(["surface:child-1", "surface:child-2"]),
      },
      {
        role: "worker",
        parentRole: "orchestrator",
        parentSurfaceId: "surface:orchestrator",
        childWorkerSurfaceIds: new Set(["surface:child-1", "surface:child-2"]),
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

    expect(placement).toEqual({
      kind: "split",
      direction: "right",
      pane: "pane:left",
    });
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

  it("docks a worker into a worker-majority right pane that also holds a stray non-role tab", () => {
    // Live scenario: the workers pane is dominated by workers but also holds a
    // non-agent tab (e.g. a setup shell / dashboard). The worker must dock into
    // it, NOT spawn a stray third pane.
    const panes = [
      makePane("pane:left", 0, ["surface:orchestrator"]),
      makePane("pane:right", 1, [
        "surface:dashboard",
        "surface:worker-1",
        "surface:worker-2",
      ]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", [
        "surface:dashboard",
        "surface:worker-1",
        "surface:worker-2",
      ]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      // surface:dashboard is unclassified (non-role); workers are the majority.
      new Set(["surface:worker-1", "surface:worker-2"]),
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
  });

  it("still splits fresh when a lone worker shares a pane with one non-role surface", () => {
    // Guard the worker-majority rule against over-reach: a single worker tied
    // with a non-role surface is NOT a worker pane — split fresh (unchanged).
    const panes = [
      makePane("pane:left", 0, ["surface:interactive", "surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", [
        "surface:interactive",
        "surface:worker-1",
      ]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1"]),
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "right",
      pane: "pane:left",
    });
  });

  it("docks a parentless worker into the rightmost non-lead pane when roles are sparse", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"]),
      makePane("pane:right", 1, ["surface:shell", "surface:notes"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", ["surface:shell", "surface:notes"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
    expect(placement).not.toEqual({ kind: "split", direction: "right" });
  });

  it("anchors the parentless worker fallback to the rightmost pane", () => {
    const panes = [makePane("pane:lead", 0, ["surface:orchestrator"])];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "right",
      pane: "pane:lead",
    });
  });

  it("does not dock a sparse parentless worker into the leftmost pane", () => {
    const panes = [makePane("pane:left", 0, ["surface:unclassified-lead"])];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:unclassified-lead"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(),
        ic: new Set(),
        worker: new Set(),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "right",
      pane: "pane:left",
    });
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
