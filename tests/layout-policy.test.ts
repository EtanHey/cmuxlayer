import { describe, expect, it } from "vitest";
import {
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  deriveColumnIndex,
  inferAgentRole,
  launcherNameForCli,
} from "../src/layout-policy.js";
import type { CmuxPane, CmuxPaneSurfaces, CmuxSurface } from "../src/types.js";

function makePane(
  ref: string,
  index: number,
  surfaceRefs: string[],
  pixelFrame?: CmuxPane["pixel_frame"],
): CmuxPane {
  return {
    ref,
    index,
    focused: index === 0,
    surface_count: surfaceRefs.length,
    surface_refs: surfaceRefs,
    selected_surface_ref: surfaceRefs[0],
    ...(pixelFrame ? { pixel_frame: pixelFrame } : {}),
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

function makeTitledSurface(
  ref: string,
  index: number,
  title: string,
): CmuxSurface {
  return {
    ref,
    title,
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

function makeTitledPaneSurfaces(
  pane: string,
  surfaces: Array<{ ref: string; title: string }>,
): CmuxPaneSurfaces {
  return {
    workspace_ref: "ws:1",
    window_ref: "window:1",
    pane_ref: pane,
    surfaces: surfaces.map((surface, index) =>
      makeTitledSurface(surface.ref, index, surface.title),
    ),
  };
}

describe("layout policy", () => {
  it("derives columns from distinct pane x positions", () => {
    const columns = deriveColumnIndex([
      makePane("pane:left", 0, [], { x: 10, y: 0, width: 300, height: 800 }),
      makePane("pane:middle", 1, [], { x: 320, y: 0, width: 300, height: 800 }),
      makePane("pane:right", 2, [], { x: 640, y: 0, width: 300, height: 800 }),
    ]);

    expect(columns.get("pane:left")).toBe(0);
    expect(columns.get("pane:middle")).toBe(1);
    expect(columns.get("pane:right")).toBe(2);
  });

  it("assigns the same column to panes sharing an x position", () => {
    const columns = deriveColumnIndex([
      makePane("pane:left", 0, [], { x: 10, y: 0, width: 300, height: 400 }),
      makePane("pane:right-top", 1, [], {
        x: 320,
        y: 0,
        width: 300,
        height: 400,
      }),
      makePane("pane:right-bottom", 2, [], {
        x: 320,
        y: 400,
        width: 300,
        height: 400,
      }),
    ]);

    expect(columns.get("pane:left")).toBe(0);
    expect(columns.get("pane:right-top")).toBe(1);
    expect(columns.get("pane:right-bottom")).toBe(1);
  });

  it("falls back to pane index ordering when geometry is missing", () => {
    const columns = deriveColumnIndex([
      makePane("pane:third", 2, []),
      makePane("pane:first", 0, []),
      makePane("pane:second", 1, []),
    ]);

    expect(columns.get("pane:first")).toBe(0);
    expect(columns.get("pane:second")).toBe(1);
    expect(columns.get("pane:third")).toBe(2);
  });

  it("falls back to index ordering for all panes when any pane lacks geometry", () => {
    const columns = deriveColumnIndex([
      makePane("pane:geometric-left", 2, [], {
        x: 0,
        y: 0,
        width: 300,
        height: 800,
      }),
      makePane("pane:index-first", 0, []),
      makePane("pane:geometric-right", 1, [], {
        x: 600,
        y: 0,
        width: 300,
        height: 800,
      }),
    ]);

    expect(columns.get("pane:index-first")).toBe(0);
    expect(columns.get("pane:geometric-right")).toBe(1);
    expect(columns.get("pane:geometric-left")).toBe(2);
  });

  it("orders partial zero-width geometry by reported x without collapsing panes", () => {
    const columns = deriveColumnIndex([
      makePane("pane:visible-right", 0, [], {
        x: 640,
        y: 0,
        width: 320,
        height: 800,
      }),
      makePane("pane:zero-left", 1, [], {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }),
    ]);

    expect(columns.get("pane:zero-left")).toBe(0);
    expect(columns.get("pane:visible-right")).toBe(1);
  });

  it("stays two-way (worker docks right, never a third column) when an unfocused workspace reports zero-area frames", () => {
    // THE invariant: cmux geometry is two-way — a LEFT lead column and a RIGHT
    // worker column, never three. cmux reports {x:0, width:0} for every pane in
    // a workspace it is not currently rendering. If that zero geometry collapses
    // the two columns into one, the lead's next worker splits RIGHT off the lead
    // pane and a THIRD column appears. Ignoring zero-area frames keeps the
    // columns distinct, so the worker docks into the existing right column.
    const zero = { x: 0, y: 0, width: 0, height: 0 };
    const panes = [
      makePane("pane:left", 0, ["surface:orchestrator"], zero),
      makePane("pane:right", 1, [], zero),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", []),
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
      },
    );

    // Docks into the existing right column (two-way). The regression is
    // { kind: "split", direction: "right", pane: "pane:left" } — a third column.
    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
  });

  it("infers default role from repoGolem launcher names", () => {
    expect(inferAgentRole({ launcherName: "orcClaude" })).toBe("orchestrator");
    expect(inferAgentRole({ launcherName: "cmuxlayerCodex" })).toBe("worker");
    expect(inferAgentRole({ launcherName: "brainlayerCursor" })).toBe("worker");
  });

  it("treats Codex leads as worker topology by default unless role is explicit", () => {
    expect(inferAgentRole({ cli: "codex" })).toBe("worker");
    expect(inferAgentRole({ cli: "codex", launcherName: "cmuxlayerCodex" })).toBe(
      "worker",
    );
    expect(
      inferAgentRole({
        cli: "codex",
        launcherName: "cmuxlayerCodex",
        role: "orchestrator",
      }),
    ).toBe("orchestrator");
  });

  it("uses the final launcher marker when repo names contain role words", () => {
    expect(inferAgentRole({ launcherName: "myClaude-toolsCodex" })).toBe(
      "worker",
    );
    expect(inferAgentRole({ launcherName: "myCodex-toolsClaude" })).toBe(
      "orchestrator",
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

  it("places orchestrators as tabs in the left-column lead pane", () => {
    const panes = [
      makePane("pane:left", 1, ["surface:lead-shell"], {
        x: 0,
        y: 0,
        width: 500,
        height: 900,
      }),
      makePane("pane:right-orc", 0, ["surface:orchestrator"], {
        x: 500,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:lead-shell"]),
      makePaneSurfaces("pane:right-orc", ["surface:orchestrator"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(),
      },
      { role: "orchestrator" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:left" });
  });

  it("places orchestrators in the left-column lead pane despite a stale IC record", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:voicelayer-lead"], {
        x: 0,
        y: 0,
        width: 500,
        height: 900,
      }),
      makePane("pane:right", 1, ["surface:cmuxlayer-worker"], {
        x: 500,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makeTitledPaneSurfaces("pane:left", [
        {
          ref: "surface:voicelayer-lead",
          title: "voicelayerClaude-LEAD",
        },
      ]),
      makeTitledPaneSurfaces("pane:right", [
        {
          ref: "surface:cmuxlayer-worker",
          title: "cmuxlayerCodex W-B1",
        },
      ]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(),
        ic: new Set(["surface:voicelayer-lead"]),
        worker: new Set(),
      },
      { role: "orchestrator" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:left" });
  });

  it("places orchestrators in pane:1 for the live lead-pane fixture with one IC record", () => {
    const panes = [
      makePane(
        "pane:1",
        0,
        [
          "surface:cmux-lead",
          "surface:voicelayer-lead",
          "surface:brainlayer-lead",
          "surface:orchestrator-lead",
        ],
        {
          x: 0,
          y: 0,
          width: 500,
          height: 900,
        },
      ),
      makePane("pane:5", 1, ["surface:worker-1", "surface:worker-2"], {
        x: 500,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makeTitledPaneSurfaces("pane:1", [
        {
          ref: "surface:cmux-lead",
          title: "cmuxlayerClaude-LEAD",
        },
        {
          ref: "surface:voicelayer-lead",
          title: "voicelayerClaude-LEAD",
        },
        {
          ref: "surface:brainlayer-lead",
          title: "brainlayerClaude-LEAD",
        },
        {
          ref: "surface:orchestrator-lead",
          title: "orchestratorClaude-LEAD",
        },
      ]),
      makeTitledPaneSurfaces("pane:5", [
        {
          ref: "surface:worker-1",
          title: "cmuxlayerCodex W-B1",
        },
        {
          ref: "surface:worker-2",
          title: "cmuxlayerCursor W-B2",
        },
      ]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(),
        ic: new Set(["surface:voicelayer-lead"]),
        worker: new Set(),
      },
      { role: "orchestrator" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:1" });
  });

  it("places orchestrators in the left-column lead pane despite a stray worker record", () => {
    const panes = [
      makePane(
        "pane:left",
        0,
        ["surface:cmux-lead", "surface:stale-worker", "surface:shell"],
        {
          x: 0,
          y: 0,
          width: 500,
          height: 900,
        },
      ),
      makePane("pane:right", 1, ["surface:actual-worker"], {
        x: 500,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makeTitledPaneSurfaces("pane:left", [
        {
          ref: "surface:cmux-lead",
          title: "cmuxlayerClaude-LEAD",
        },
        {
          ref: "surface:stale-worker",
          title: "voicelayerClaude-LEAD",
        },
        {
          ref: "surface:shell",
          title: "manual shell",
        },
      ]),
      makeTitledPaneSurfaces("pane:right", [
        {
          ref: "surface:actual-worker",
          title: "cmuxlayerCodex W-B1",
        },
      ]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(),
        ic: new Set(),
        worker: new Set(["surface:stale-worker"]),
      },
      { role: "orchestrator" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:left" });
  });

  it("splits orchestrators left when the leftmost pane is worker-majority despite a stale IC record", () => {
    const panes = [
      makePane(
        "pane:left-workers",
        0,
        [
          "surface:worker-1",
          "surface:worker-2",
          "surface:worker-3",
          "surface:stale-ic",
        ],
        {
          x: 0,
          y: 0,
          width: 500,
          height: 900,
        },
      ),
      makePane("pane:right-workers", 1, ["surface:worker-4"], {
        x: 500,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makeTitledPaneSurfaces("pane:left-workers", [
        {
          ref: "surface:worker-1",
          title: "cmuxlayerCodex W-B1",
        },
        {
          ref: "surface:worker-2",
          title: "cmuxlayerCodex W-B2",
        },
        {
          ref: "surface:worker-3",
          title: "cmuxlayerCursor W-B3",
        },
        {
          ref: "surface:stale-ic",
          title: "cmuxlayerCodex W-B4",
        },
      ]),
      makeTitledPaneSurfaces("pane:right-workers", [
        {
          ref: "surface:worker-4",
          title: "cmuxlayerCodex W-B5",
        },
      ]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(),
        ic: new Set(["surface:stale-ic"]),
        worker: new Set(),
      },
      { role: "orchestrator" },
    );

    expect(placement).toEqual({ kind: "split", direction: "left" });
  });

  it("docks workers into launcher-title Codex panes without registry state", () => {
    const panes = [makePane("pane:worker", 0, ["surface:cmuxlayer-worker"])];
    const paneSurfaces = [
      makeTitledPaneSurfaces("pane:worker", [
        {
          ref: "surface:cmuxlayer-worker",
          title: "cmuxlayerCodex W-B1",
        },
      ]),
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

    expect(placement).toEqual({ kind: "surface", pane: "pane:worker" });
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

  it("docks a parent IC's first child into the rightmost worker column when one exists", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:orc"]),
      makePane("pane:ic", 1, ["surface:ic"]),
      makePane("pane:other-workers", 2, ["surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orc"]),
      makePaneSurfaces("pane:ic", ["surface:ic"]),
      makePaneSurfaces("pane:other-workers", ["surface:worker-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orc"]),
        ic: new Set(["surface:ic"]),
        worker: new Set(["surface:worker-1"]),
      },
      {
        role: "worker",
        parentRole: "ic",
        parentSurfaceId: "surface:ic",
        childWorkerSurfaceIds: new Set(),
      },
    );

    expect(placement).toEqual({
      kind: "surface",
      pane: "pane:other-workers",
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

  it("docks the first child worker into an existing right-column non-lead pane", () => {
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
      kind: "surface",
      pane: "pane:notes",
    });
  });

  it("docks a parent orchestrator's first child into the rightmost worker column when one exists", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"]),
      makePane("pane:other-workers", 1, ["surface:worker-1"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:other-workers", ["surface:worker-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(["surface:worker-1"]),
      },
      {
        role: "worker",
        parentRole: "orchestrator",
        parentSurfaceId: "surface:orchestrator",
        childWorkerSurfaceIds: new Set(),
      },
    );

    expect(placement).toEqual({
      kind: "surface",
      pane: "pane:other-workers",
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

  it("docks a worker into the right column despite the live non-role-majority pane", () => {
    const nonRoleSurfaces = Array.from({ length: 15 }, (_, index) => ({
      ref: `surface:judge-${index + 1}`,
      title:
        index % 3 === 0
          ? "Judge Worker"
          : index % 3 === 1
            ? "voicelayer"
            : "Red Team Judge",
    }));
    const rightSurfaces = [
      ...nonRoleSurfaces,
      {
        ref: "surface:worker",
        title: "cmuxlayerCursor W-F3",
      },
    ];
    const panes = [
      makePane(
        "pane:1",
        0,
        [
          "surface:cmux-lead",
          "surface:voicelayer-lead",
          "surface:brainlayer-lead",
          "surface:orchestrator-lead",
        ],
        {
          x: 0,
          y: 0,
          width: 500,
          height: 900,
        },
      ),
      makePane(
        "pane:5",
        1,
        rightSurfaces.map((surface) => surface.ref),
        {
          x: 500,
          y: 0,
          width: 500,
          height: 900,
        },
      ),
    ];
    const paneSurfaces = [
      makeTitledPaneSurfaces("pane:1", [
        {
          ref: "surface:cmux-lead",
          title: "cmuxlayerClaude-LEAD",
        },
        {
          ref: "surface:voicelayer-lead",
          title: "voicelayerClaude-LEAD",
        },
        {
          ref: "surface:brainlayer-lead",
          title: "brainlayerClaude-LEAD",
        },
        {
          ref: "surface:orchestrator-lead",
          title: "orchestratorClaude-LEAD",
        },
      ]),
      makeTitledPaneSurfaces("pane:5", rightSurfaces),
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

    expect(placement).toEqual({ kind: "surface", pane: "pane:5" });
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

  it("docks into a clean right-column pane instead of repairing a mixed left worker pane", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:interactive", "surface:worker-1"]),
      makePane("pane:right", 1, ["surface:notes"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", [
        "surface:interactive",
        "surface:worker-1",
      ]),
      makePaneSurfaces("pane:right", ["surface:notes"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      new Set(["surface:worker-1"]),
    );

    expect(placement).toEqual({
      kind: "surface",
      pane: "pane:right",
    });
  });

  it("docks into a clean right-column pane when an unknown worker contaminates the left pane", () => {
    const panes = [
      makePane("pane:left", 0, [
        "surface:interactive",
        "surface:unknown-worker",
      ]),
      makePane("pane:right", 1, ["surface:notes"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", [
        "surface:interactive",
        "surface:unknown-worker",
      ]),
      makePaneSurfaces("pane:right", ["surface:notes"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(),
        ic: new Set(),
        worker: new Set(),
        unknown: new Set(["surface:unknown-worker"]),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({
      kind: "surface",
      pane: "pane:right",
    });
  });

  it("docks into an existing non-lead unknown worker zone instead of creating a third column", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:orchestrator"], {
        x: 0,
        y: 0,
        width: 500,
        height: 900,
      }),
      makePane("pane:right", 1, ["surface:unknown-worker"], {
        x: 500,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", ["surface:unknown-worker"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(),
        unknown: new Set(["surface:unknown-worker"]),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
  });

  it("uses geometry columns, not pane indexes, to identify the non-lead worker zone", () => {
    const panes = [
      makePane("pane:right", 0, ["surface:unknown-worker"], {
        x: 500,
        y: 0,
        width: 500,
        height: 900,
      }),
      makePane("pane:left", 1, ["surface:orchestrator"], {
        x: 0,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:right", ["surface:unknown-worker"]),
      makePaneSurfaces("pane:left", ["surface:orchestrator"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(),
        unknown: new Set(["surface:unknown-worker"]),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
  });

  it("docks into a contaminated right-column worker zone rather than creating a third column", () => {
    const panes = [
      makePane("pane:left", 0, ["surface:orchestrator"]),
      makePane("pane:right", 1, ["surface:unknown-worker", "surface:shell"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:left", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", [
        "surface:unknown-worker",
        "surface:shell",
      ]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(),
        unknown: new Set(["surface:unknown-worker"]),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({
      kind: "surface",
      pane: "pane:right",
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

  it("prefers sparse worker docking over the IC fallback for parentless workers", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"]),
      makePane("pane:ic", 1, ["surface:ic"]),
      makePane("pane:right", 2, ["surface:shell"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:ic", ["surface:ic"]),
      makePaneSurfaces("pane:right", ["surface:shell"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(["surface:ic"]),
        worker: new Set(),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
  });

  it("preserves the IC fallback when no sparse worker seed pane exists", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"]),
      makePane("pane:ic", 1, ["surface:ic"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:ic", ["surface:ic"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(["surface:ic"]),
        worker: new Set(),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "down",
      pane: "pane:ic",
    });
  });

  it("treats worker role ids missing from the live layout as sparse", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"]),
      makePane("pane:right", 1, ["surface:shell"]),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", ["surface:shell"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(["surface:stale-worker"]),
      },
      { role: "worker" },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
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

  it("seeds a worktree worker column without anchoring to the left lead pane", () => {
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
      {
        role: "worker",
        parentRole: "orchestrator",
        parentSurfaceId: "surface:orchestrator",
        worktree: true,
      },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "right",
    });
  });

  it("does not dock an nth worktree worker into a left-column worker pane", () => {
    const leftColumn = { x: 0, y: 0, width: 500, height: 900 };
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"], leftColumn),
      makePane("pane:left-worker", 1, ["surface:worker-1"], leftColumn),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:left-worker", ["surface:worker-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(["surface:worker-1"]),
      },
      { role: "worker", worktree: true },
    );

    expect(placement).toEqual({
      kind: "split",
      direction: "right",
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
      makePaneSurfaces("pane:left", [
        "surface:interactive",
        "surface:worker-1",
      ]),
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

describe("worktree worker placement — always right, never left", () => {
  const leftColumn = { x: 0, y: 0, width: 500, height: 900 };
  const rightColumn = { x: 500, y: 0, width: 500, height: 900 };

  function assertNeverLeft(placement: {
    kind: string;
    direction?: string;
    pane?: string;
  }): void {
    // No left split, ever.
    expect(placement).not.toEqual({ kind: "split", direction: "left" });
    if (placement.kind === "split") {
      expect(placement.direction).not.toBe("left");
    }
  }

  it("(a) single lead column: seeds the right worker column via a right split", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"], leftColumn),
    ];
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
      {
        role: "worker",
        parentRole: "orchestrator",
        parentSurfaceId: "surface:orchestrator",
        worktree: true,
      },
    );

    expect(placement).toEqual({ kind: "split", direction: "right" });
    assertNeverLeft(placement);
  });

  it("(b) lead column + existing right worker pane: DOCKS as a tab, not a new pane", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"], leftColumn),
      makePane("pane:right", 1, ["surface:worker-1"], rightColumn),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", ["surface:worker-1"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(["surface:worker-1"]),
      },
      {
        role: "worker",
        parentRole: "orchestrator",
        parentSurfaceId: "surface:orchestrator",
        worktree: true,
      },
    );

    // Docks into the existing rightmost worker pane as a tab — never a new
    // pane and never a left placement.
    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
    expect(placement).not.toEqual({ kind: "split", direction: "right" });
    assertNeverLeft(placement);
  });

  it("(b2) picks the rightmost worker column when several worker panes exist", () => {
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"], leftColumn),
      makePane("pane:right", 1, ["surface:worker-1"], rightColumn),
      makePane("pane:rightmost", 2, ["surface:worker-2"], {
        x: 1000,
        y: 0,
        width: 500,
        height: 900,
      }),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:right", ["surface:worker-1"]),
      makePaneSurfaces("pane:rightmost", ["surface:worker-2"]),
    ];

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(["surface:worker-1", "surface:worker-2"]),
      },
      {
        role: "worker",
        parentRole: "orchestrator",
        parentSurfaceId: "surface:orchestrator",
        worktree: true,
      },
    );

    expect(placement).toEqual({ kind: "surface", pane: "pane:rightmost" });
    assertNeverLeft(placement);
  });

  it("(c) nth worker while a prior worker is stuck in the LEFT column: docks into the RIGHT column, never the left worker", () => {
    // A real two-column layout: the lead AND a stray prior worker both live in
    // the LEFT column (same x), while a genuine RIGHT worker column exists.
    // columnCount is therefore 2 — this REACHES the rightmost-worker dock path
    // (not the single-column early return that cases (a)/(c-old) hit). The
    // worktree worker must dock as a tab into the RIGHT worker pane and must
    // NEVER dock into the left-column worker.
    const leftLead = { x: 0, y: 0, width: 500, height: 450 };
    const leftWorker = { x: 0, y: 450, width: 500, height: 450 };
    const panes = [
      makePane("pane:lead", 0, ["surface:orchestrator"], leftLead),
      makePane("pane:left-worker", 1, ["surface:worker-left"], leftWorker),
      makePane("pane:right", 2, ["surface:worker-right"], rightColumn),
    ];
    const paneSurfaces = [
      makePaneSurfaces("pane:lead", ["surface:orchestrator"]),
      makePaneSurfaces("pane:left-worker", ["surface:worker-left"]),
      makePaneSurfaces("pane:right", ["surface:worker-right"]),
    ];

    // Sanity: the fixture is genuinely two-column (regression guard against the
    // earlier bug where identical left rects collapsed to columnCount === 1 and
    // the test never exercised the dock path).
    const columns = deriveColumnIndex(panes);
    expect(new Set(columns.values()).size).toBe(2);

    const placement = chooseAgentSpawnPlacement(
      panes,
      paneSurfaces,
      {
        orchestrator: new Set(["surface:orchestrator"]),
        ic: new Set(),
        worker: new Set(["surface:worker-left", "surface:worker-right"]),
      },
      { role: "worker", worktree: true },
    );

    // Docks as a tab into the RIGHT worker column — never into the left worker.
    expect(placement).toEqual({ kind: "surface", pane: "pane:right" });
    expect(placement).not.toEqual({
      kind: "surface",
      pane: "pane:left-worker",
    });
    assertNeverLeft(placement);
  });
});
