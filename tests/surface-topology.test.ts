import { describe, expect, it, vi } from "vitest";
import { collectSurfaceTopology } from "../src/surface-topology.js";
import type {
  CmuxPane,
  CmuxPaneSurfaces,
  CmuxSurface,
  CmuxWorkspace,
} from "../src/types.js";

function workspace(ref: string): CmuxWorkspace {
  return {
    ref,
    title: ref,
    index: 0,
    selected: false,
    pinned: false,
  };
}

function pane(ref: string, index: number, surfaceRefs: string[]): CmuxPane {
  return {
    ref,
    index,
    focused: index === 0,
    surface_count: surfaceRefs.length,
    surface_refs: surfaceRefs,
  };
}

function surface(ref: string): CmuxSurface {
  return {
    ref,
    title: ref,
    type: "terminal",
    index: 0,
    selected: false,
  };
}

describe("collectSurfaceTopology", () => {
  it("keeps usable pane topology when another pane surface lookup fails", async () => {
    const panes = [pane("pane:ok", 0, ["surface:ok"]), pane("pane:gone", 1, [])];
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [workspace("workspace:1")],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes,
      }),
      listPaneSurfaces: vi.fn(
        async (opts: { workspace?: string; pane?: string }) => {
          if (opts.pane === "pane:gone") {
            throw new Error("pane closed");
          }
          return {
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:ok",
            surfaces: [surface("surface:ok")],
          } satisfies CmuxPaneSurfaces;
        },
      ),
    };

    const snapshot = await collectSurfaceTopology(client);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.workspaceBySurface.get("surface:ok")).toBe("workspace:1");
    expect(snapshot?.topologyBySurface.get("surface:ok")).toEqual({
      column: 0,
      column_count: 2,
    });
  });
});
