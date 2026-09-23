import { vi } from "vitest";
import type { CmuxClient, ExecFn } from "../../src/cmux-client.js";

type FakeSurface = { ref: string; id?: string; pane_ref?: string; [key: string]: unknown };
type FakePane = {
  ref: string;
  index: number;
  surface_refs: string[];
  surface_ids?: string[];
  surface_count: number;
  selected_surface_ref?: string;
  pixel_frame?: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
};
type FakeSplit = {
  workspace: string;
  pane: string;
  surfaces: Map<string, FakeSurface>;
};

function parseObject(stdout: string): Record<string, any> | null {
  try {
    const value = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value : null;
  } catch {
    return null;
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** Give CLI fakes the column that a successful new-split(right) actually creates. */
export function withFakeRightSplitTopology(exec: ExecFn): ExecFn {
  const splits = new Map<string, FakeSplit>();
  const lastPanes = new Map<string, FakePane[]>();
  let lastWorkspace = "";
  let nextPane = 1;

  return vi.fn(async (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => {
    const result = await exec(cmd, args, env);
    const command = args.find((arg) => [
      "list-panes", "list-pane-surfaces", "new-split", "new-surface", "close-surface",
    ].includes(arg));
    const parsed = parseObject(result.stdout);
    const workspace = option(args, "--workspace") ??
      String(parsed?.workspace_ref ?? parsed?.workspace ?? lastWorkspace);

    if (command === "list-panes" && Array.isArray(parsed?.panes)) {
      lastWorkspace = workspace;
      const panes = parsed.panes as FakePane[];
      lastPanes.set(workspace, panes);
      const split = splits.get(workspace);
      if (!split) return result;
      const rightRefs = new Set(split.surfaces.keys());
      const base = panes.map((pane, index) => {
        const refs = pane.surface_refs.filter((ref) => !rightRefs.has(ref));
        const ids = pane.surface_ids?.filter(
          (_id, surfaceIndex) => !rightRefs.has(pane.surface_refs[surfaceIndex]),
        );
        return {
          ...pane,
          index,
          surface_refs: refs,
          surface_count: refs.length,
          ...(ids ? { surface_ids: ids } : {}),
          selected_surface_ref: refs.includes(pane.selected_surface_ref ?? "")
            ? pane.selected_surface_ref : refs[0],
          pixel_frame: pane.pixel_frame ?? {
            x: index * 500, y: 0, width: 500, height: 900,
          },
        };
      });
      const rightX = Math.max(...base.map(
        (pane) => pane.pixel_frame.x + pane.pixel_frame.width,
      ));
      const surfaces = [...split.surfaces.values()];
      const surfaceIds = surfaces.map((surface) => surface.id);
      const right: FakePane = {
        ref: split.pane,
        index: base.length,
        focused: false,
        surface_count: surfaces.length,
        surface_refs: surfaces.map((surface) => surface.ref),
        ...(surfaceIds.every(Boolean) ? { surface_ids: surfaceIds as string[] } : {}),
        selected_surface_ref: surfaces[0]?.ref,
        pixel_frame: { x: rightX, y: 0, width: 500, height: 900 },
      };
      return {
        ...result,
        stdout: JSON.stringify({ ...parsed, panes: [...base, right] }),
      };
    }

    if (command === "list-pane-surfaces" && Array.isArray(parsed?.surfaces)) {
      const split = splits.get(workspace);
      if (!split) return result;
      const requestedPane = option(args, "--pane");
      const rightRefs = new Set(split.surfaces.keys());
      const originals = parsed.surfaces as FakeSurface[];
      const surfaces = requestedPane === split.pane
        ? [...split.surfaces.values()].map((surface) => ({
            ...(originals.find((candidate) => candidate.ref === surface.ref) ?? surface),
            pane_ref: split.pane,
          }))
        : requestedPane
          ? originals.filter((surface) => !rightRefs.has(surface.ref))
          : [
              ...originals.filter((surface) => !rightRefs.has(surface.ref)),
              ...[...split.surfaces.values()].map((surface) => ({
                ...(originals.find((candidate) => candidate.ref === surface.ref) ?? surface),
                pane_ref: split.pane,
              })),
            ];
      return {
        ...result,
        stdout: JSON.stringify({
          ...parsed,
          pane_ref: requestedPane ?? parsed.pane_ref,
          surfaces,
        }),
      };
    }

    if (command === "new-split" && args[args.indexOf("new-split") + 1] === "right" &&
        typeof parsed?.surface === "string") {
      const knownPanes = lastPanes.get(workspace) ?? [];
      const returnedPane = typeof parsed.pane === "string" ? parsed.pane : "";
      const pane = returnedPane && !knownPanes.some((candidate) => candidate.ref === returnedPane)
        ? returnedPane : `pane:fake-right-${nextPane++}`;
      splits.set(workspace, {
        workspace,
        pane,
        surfaces: new Map([[parsed.surface, {
          ref: parsed.surface,
          ...(typeof parsed.surface_id === "string" ? { id: parsed.surface_id } : {}),
          title: parsed.title ?? "agent-pane",
          type: parsed.type ?? "terminal",
          index: 0,
          selected: true,
          pane_ref: pane,
        }]]),
      });
      return { ...result, stdout: JSON.stringify({ ...parsed, pane }) };
    }

    if (command === "new-surface" && typeof parsed?.surface === "string") {
      const split = splits.get(workspace);
      if (split && option(args, "--pane") === split.pane) {
        split.surfaces.set(parsed.surface, {
          ref: parsed.surface,
          ...(typeof parsed.surface_id === "string" ? { id: parsed.surface_id } : {}),
          title: parsed.title ?? "agent-pane",
          type: parsed.type ?? "terminal",
          index: split.surfaces.size,
          selected: true,
          pane_ref: split.pane,
        });
      }
    }

    if (command === "close-surface") {
      const split = splits.get(workspace);
      if (split) {
        for (const ref of split.surfaces.keys()) {
          if (args.includes(ref)) split.surfaces.delete(ref);
        }
        if (split.surfaces.size === 0) splits.delete(workspace);
      }
    }
    return result;
  });
}

/** The same observable right-column transition for direct CmuxClient fakes. */
export function withFakeRightSplitClient(client: CmuxClient): void {
  const newSplit = client.newSplit.bind(client);
  const listPanes = client.listPanes.bind(client);
  const listPaneSurfaces = client.listPaneSurfaces.bind(client);
  let split: FakeSplit | null = null;

  client.newSplit = vi.fn(async (direction, opts) => {
    const result = await newSplit(direction, opts);
    if (direction === "right") {
      split = {
        workspace: opts?.workspace ?? result.workspace ?? "",
        pane: "pane:fake-right-client",
        surfaces: new Map([[result.surface, {
          ref: result.surface,
          ...(result.surface_id ? { id: result.surface_id } : {}),
          title: result.title,
          type: result.type,
          pane_ref: "pane:fake-right-client",
        }]]),
      };
    }
    return result;
  });
  client.listPanes = vi.fn(async (opts) => {
    const snapshot = await listPanes(opts);
    if (!split || split.workspace !== (opts?.workspace ?? "")) return snapshot;
    const rightRefs = new Set(split.surfaces.keys());
    const panes = snapshot.panes.map((pane, index) => {
      const refs = pane.surface_refs.filter((ref) => !rightRefs.has(ref));
      return {
        ...pane,
        index,
        surface_refs: refs,
        surface_count: refs.length,
        selected_surface_ref: refs[0],
        pixel_frame: pane.pixel_frame ?? {
          x: index * 500, y: 0, width: 500, height: 900,
        },
      };
    });
    const x = Math.max(...panes.map(
      (pane) => pane.pixel_frame.x + pane.pixel_frame.width,
    ));
    return {
      ...snapshot,
      panes: [...panes, {
        ref: split.pane,
        index: panes.length,
        focused: false,
        surface_count: split.surfaces.size,
        surface_refs: [...split.surfaces.keys()],
        selected_surface_ref: [...split.surfaces.keys()][0],
        pixel_frame: { x, y: 0, width: 500, height: 900 },
      }],
    };
  });
  client.listPaneSurfaces = vi.fn(async (opts) => {
    const snapshot = await listPaneSurfaces(opts);
    if (!split || split.workspace !== (opts?.workspace ?? "")) return snapshot;
    const rightRefs = new Set(split.surfaces.keys());
    return {
      ...snapshot,
      pane_ref: opts?.pane ?? snapshot.pane_ref,
      surfaces: opts?.pane === split.pane
        ? [...split.surfaces.values()] as typeof snapshot.surfaces
        : opts?.pane
          ? snapshot.surfaces.filter((surface) => !rightRefs.has(surface.ref))
          : snapshot.surfaces,
    };
  });
}
