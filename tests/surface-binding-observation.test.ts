import { describe, expect, it } from "vitest";
import {
  buildSurfaceBindingObservation,
  isPaneSurfaceEnumerationComplete,
} from "../src/surface-binding-observation.js";
import type { CmuxPane, CmuxPaneSurfaces } from "../src/types.js";

describe("buildSurfaceBindingObservation", () => {
  it("rejects a successful pane-surface subset as incomplete", () => {
    const panes: CmuxPane[] = [
      {
        ref: "pane:1",
        index: 0,
        focused: true,
        surface_count: 2,
        surface_refs: ["surface:1", "surface:2"],
        surface_ids: ["uuid-1", "uuid-2"],
      },
    ];
    const paneSurfaces: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:1",
            id: "uuid-1",
            title: "worker",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      },
    ];

    expect(isPaneSurfaceEnumerationComplete(panes, paneSurfaces)).toBe(false);
  });

  it("accepts an exact, duplicate-free pane-surface enumeration", () => {
    const panes: CmuxPane[] = [
      {
        ref: "pane:1",
        index: 0,
        focused: true,
        surface_count: 2,
        surface_refs: ["surface:1", "surface:2"],
      },
    ];
    const paneSurfaces: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:1",
            title: "worker 1",
            type: "terminal",
            index: 0,
            selected: true,
          },
          {
            ref: "surface:2",
            title: "worker 2",
            type: "terminal",
            index: 1,
            selected: false,
          },
        ],
      },
    ];

    expect(isPaneSurfaceEnumerationComplete(panes, paneSurfaces)).toBe(true);
  });

  it("rejects contradictory pane and surface UUID evidence for one ref", () => {
    const panes: CmuxPane[] = [
      {
        ref: "pane:1",
        index: 0,
        focused: true,
        surface_count: 1,
        surface_refs: ["surface:1"],
        surface_ids: ["uuid-from-pane"],
      },
    ];
    const paneSurfaces: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:1",
            id: "uuid-from-surface",
            title: "worker",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      },
    ];

    const observation = buildSurfaceBindingObservation(panes, paneSurfaces);

    expect(observation.coverage).toBe("conflict");
    expect(observation.surfaceUuidByRef).toEqual(new Map());
    expect(observation.surfaceRefByUuid).toEqual(new Map());
  });
});
