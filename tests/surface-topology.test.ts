import { describe, expect, it, vi } from "vitest";
import { evaluateAgentHealth } from "../src/agent-health.js";
import type { AgentRecord } from "../src/agent-types.js";
import {
  collectSurfaceTopology,
  enrichSurfaceIdsFromPanes,
  healthTopologyOverrides,
  resolveAgentSurfaceBinding,
  SurfaceIdentityConflictError,
} from "../src/surface-topology.js";
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

function positionedPane(
  ref: string,
  index: number,
  surfaceRefs: string[],
  x: number,
): CmuxPane {
  return {
    ...pane(ref, index, surfaceRefs),
    pixel_frame: { x, y: 0, width: 500, height: 900 },
  };
}

function surface(ref: string, title = ref): CmuxSurface {
  return {
    ref,
    title,
    type: "terminal",
    index: 0,
    selected: false,
  };
}

function makeRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "cmuxlayerCodex-topology-fixture",
    surface_id: "surface:worker-right",
    workspace_id: "workspace:1",
    state: "ready",
    repo: "cmuxlayer",
    model: "gpt-5.5",
    cli: "codex",
    cli_session_id: "019f0001-1111-7222-8333-444455556666",
    cli_session_path: null,
    launcher_name: null,
    task_summary: "Topology fixture",
    pid: null,
    version: 1,
    created_at: "2026-07-06T12:00:00.000Z",
    updated_at: "2026-07-06T12:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: true,
    respawn_attempts: 0,
    user_killed: false,
    boot_prompt_pending: false,
    launch_cwd: null,
    mcp_profile: null,
    worktree_path: null,
    worktree_branch: null,
    ...overrides,
  };
}

function makeTopologyClient(
  panes: CmuxPane[],
  groups: CmuxPaneSurfaces[],
) {
  return {
    listWorkspaces: vi.fn().mockResolvedValue({
      workspaces: [workspace("workspace:1")],
    }),
    listPanes: vi.fn().mockResolvedValue({
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      panes,
    }),
    listPaneSurfaces: vi.fn(
      async (opts: { workspace?: string; pane?: string }) =>
        groups.find((group) => group.pane_ref === opts.pane) ??
        ({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: opts.pane ?? "pane:unknown",
          surfaces: [],
        } satisfies CmuxPaneSurfaces),
    ),
  };
}

function healthFor(
  agent: AgentRecord,
  snapshot: Awaited<ReturnType<typeof collectSurfaceTopology>>,
) {
  return evaluateAgentHealth(agent, {
    monitor_alive: true,
    ...healthTopologyOverrides(agent, snapshot),
  });
}

describe("enrichSurfaceIdsFromPanes", () => {
  it("rejects a surface UUID that contradicts the pane membership UUID", () => {
    const panes = [
      {
        ref: "workspace:1",
        panes: {
          panes: [
            {
              ...pane("pane:1", 0, ["surface:1"]),
              surface_ids: ["11111111-2222-4333-8444-555555555555"],
            },
          ],
        },
      },
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ...surface("surface:1"),
            id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
          },
        ],
      },
    ];

    expect(() => enrichSurfaceIdsFromPanes(panes, groups)).toThrow(
      SurfaceIdentityConflictError,
    );
  });

  it("rejects one stable UUID observed on two mutable refs", () => {
    const duplicateUuid = "11111111-2222-4333-8444-555555555555";
    const panes = [
      {
        ref: "workspace:1",
        panes: {
          panes: [
            {
              ...pane("pane:1", 0, ["surface:1", "surface:2"]),
              surface_ids: [duplicateUuid, duplicateUuid],
            },
          ],
        },
      },
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [surface("surface:1"), surface("surface:2")],
      },
    ];

    expect(() => enrichSurfaceIdsFromPanes(panes, groups)).toThrow(
      SurfaceIdentityConflictError,
    );
  });
});

describe("collectSurfaceTopology", () => {
  it("returns null when a configured surface observer is unknown", async () => {
    const client = makeTopologyClient(
      [pane("pane:right", 0, ["surface:1"])],
      [
        {
          workspace_ref: "workspace:1",
          pane_ref: "pane:right",
          surfaces: [surface("surface:1")],
        },
      ],
    );

    const snapshot = await collectSurfaceTopology(
      client,
      "workspace:1",
      () => null,
    );

    expect(snapshot).toBeNull();
    expect(client.listPanes).not.toHaveBeenCalled();
    expect(client.listPaneSurfaces).not.toHaveBeenCalled();
  });

  it("returns null when the surface observer changes mid-enumeration", async () => {
    let observerId = "cmux:/tmp/cmux-primary.sock";
    const client = makeTopologyClient(
      [
        {
          ...pane("pane:right", 0, ["surface:1"]),
          surface_ids: ["11111111-2222-4333-8444-555555555555"],
        },
      ],
      [
        {
          workspace_ref: "workspace:1",
          pane_ref: "pane:right",
          surfaces: [
            {
              ...surface("surface:1"),
              id: "11111111-2222-4333-8444-555555555555",
            },
          ],
        },
      ],
    );
    const listPaneSurfaces = client.listPaneSurfaces.getMockImplementation()!;
    client.listPaneSurfaces.mockImplementation(async (opts) => {
      const result = await listPaneSurfaces(opts);
      observerId = "cmux:/tmp/cmux-secondary.sock";
      return result;
    });

    const snapshot = await collectSurfaceTopology(
      client,
      "workspace:1",
      () => observerId,
    );

    expect(observerId).toBe("cmux:/tmp/cmux-secondary.sock");
    expect(snapshot).toBeNull();
  });

  it("resolves a stale ref through the stable UUID from the same topology observation", async () => {
    const surfaceUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
    const panes = [
      {
        ...pane("pane:right", 0, ["surface:595"]),
        surface_ids: [surfaceUuid],
      },
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:right",
        surfaces: [surface("surface:595", "cmuxlayerCodex [surface:595]")],
      },
    ];
    const snapshot = await collectSurfaceTopology(
      makeTopologyClient(panes, groups),
      "workspace:1",
    );
    const agent = makeRecord({
      surface_id: "surface:594",
      surface_uuid: surfaceUuid,
    });

    expect(snapshot?.surfaceIdByRef.get("surface:595")).toBe(surfaceUuid);
    expect(snapshot?.surfaceRefById.get(surfaceUuid)).toBe("surface:595");
    expect(resolveAgentSurfaceBinding(agent, snapshot)).toEqual({
      surfaceUuid,
      surfaceRef: "surface:595",
      workspaceId: "workspace:1",
      title: "cmuxlayerCodex [surface:595]",
      provenance: "uuid",
    });
  });

  it("resolves a stable UUID case-insensitively", async () => {
    const observedUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
    const persistedUuid = observedUuid.toLowerCase();
    const panes = [
      {
        ...pane("pane:right", 0, ["surface:595"]),
        surface_ids: [observedUuid],
      },
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:right",
        surfaces: [surface("surface:595", "cmuxlayerCodex")],
      },
    ];
    const snapshot = await collectSurfaceTopology(
      makeTopologyClient(panes, groups),
      "workspace:1",
    );

    expect([...snapshot!.surfaceRefById]).toEqual([
      [observedUuid, "surface:595"],
    ]);
    expect(
      resolveAgentSurfaceBinding(
        makeRecord({
          surface_id: "surface:stale",
          surface_uuid: persistedUuid,
        }),
        snapshot,
      ),
    ).toMatchObject({
      surfaceUuid: observedUuid,
      surfaceRef: "surface:595",
      provenance: "uuid",
    });
  });

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
    expect(snapshot?.complete).toBe(false);
    expect(snapshot?.workspaceBySurface.get("surface:ok")).toBe("workspace:1");
    expect(snapshot?.topologyBySurface.get("surface:ok")).toEqual({
      column: 0,
      column_count: 2,
    });
    expect(
      resolveAgentSurfaceBinding(
        makeRecord({ surface_id: "surface:ok" }),
        snapshot,
      ),
    ).toBeNull();
  });

  it("marks a successful but truncated pane-surface enumeration incomplete", async () => {
    const firstUuid = "11111111-2222-4333-8444-555555555555";
    const missingUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const panes = [
      {
        ...pane("pane:two-seats", 0, ["surface:first", "surface:missing"]),
        surface_ids: [firstUuid, missingUuid],
      },
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:two-seats",
        // The command succeeded, but cmux returned only one of the two surfaces
        // advertised by the same pane observation.
        surfaces: [
          { ...surface("surface:first"), id: firstUuid },
        ],
      },
    ];

    const snapshot = await collectSurfaceTopology(
      makeTopologyClient(panes, groups),
      "workspace:1",
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.complete).toBe(false);
    expect(snapshot?.workspaceBySurface.has("surface:first")).toBe(true);
    expect(snapshot?.workspaceBySurface.has("surface:missing")).toBe(false);
    expect(
      resolveAgentSurfaceBinding(
        makeRecord({
          surface_id: "surface:first",
          surface_uuid: firstUuid,
        }),
        snapshot,
      ),
    ).toBeNull();
  });

  it("removes both sides of a contradictory UUID mapping", async () => {
    const duplicateUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
    const panes = [
      pane("pane:first", 0, ["surface:first"]),
      pane("pane:second", 1, ["surface:second"]),
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:first",
        surfaces: [
          { ...surface("surface:first", "first"), id: duplicateUuid },
        ],
      },
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:second",
        surfaces: [
          { ...surface("surface:second", "second"), id: duplicateUuid },
        ],
      },
    ];

    const snapshot = await collectSurfaceTopology(
      makeTopologyClient(panes, groups),
      "workspace:1",
    );

    expect(snapshot?.complete).toBe(false);
    expect(snapshot?.surfaceRefById.has(duplicateUuid)).toBe(false);
    expect(snapshot?.surfaceIdByRef.has("surface:first")).toBe(false);
    expect(snapshot?.surfaceIdByRef.has("surface:second")).toBe(false);
    expect(
      resolveAgentSurfaceBinding(
        makeRecord({
          surface_id: "surface:first",
          surface_uuid: duplicateUuid,
        }),
        snapshot,
      ),
    ).toBeNull();
  });

  it("treats mixed stable-identity coverage as an incomplete snapshot", async () => {
    const stableUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
    const panes = [
      {
        ...pane("pane:mixed", 0, ["surface:identified", "surface:ref-only"]),
        surface_ids: [stableUuid],
      },
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:mixed",
        surfaces: [
          { ...surface("surface:identified"), id: stableUuid },
          surface("surface:ref-only"),
        ],
      },
    ];

    const snapshot = await collectSurfaceTopology(
      makeTopologyClient(panes, groups),
      "workspace:1",
    );

    expect(snapshot?.complete).toBe(false);
    expect(
      resolveAgentSurfaceBinding(
        makeRecord({
          surface_id: "surface:identified",
          surface_uuid: stableUuid,
        }),
        snapshot,
      ),
    ).toBeNull();
  });

  it("turns live pane placement into blocking role-zone health", async () => {
    const panes = [
      positionedPane("pane:left", 0, ["surface:worker-left"], 0),
      positionedPane("pane:center", 1, ["surface:lead-center"], 500),
      positionedPane("pane:right", 2, ["surface:worker-right"], 1000),
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:left",
        surfaces: [surface("surface:worker-left", "cmuxlayerCodex W-A1")],
      },
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:center",
        surfaces: [surface("surface:lead-center", "cmuxlayerClaude-LEAD")],
      },
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:right",
        surfaces: [surface("surface:worker-right", "cmuxlayerCodex W-A2")],
      },
    ];
    const snapshot = await collectSurfaceTopology(
      makeTopologyClient(panes, groups),
      "workspace:1",
    );
    expect(snapshot).not.toBeNull();

    const centerLeadHealth = healthFor(
      makeRecord({ surface_id: "surface:lead-center", role: undefined }),
      snapshot,
    );
    expect(centerLeadHealth.status).toBe("unhealthy");
    expect(centerLeadHealth.issue_codes).toEqual(
      expect.arrayContaining([
        "topology_three_or_more_columns",
        "orchestrator_not_leftmost",
      ]),
    );
    expect(centerLeadHealth.issue_severities).toMatchObject({
      topology_three_or_more_columns: "blocking",
      orchestrator_not_leftmost: "blocking",
    });

    const leftWorkerHealth = healthFor(
      makeRecord({ surface_id: "surface:worker-left", role: undefined }),
      snapshot,
    );
    expect(leftWorkerHealth.status).toBe("unhealthy");
    expect(leftWorkerHealth.issue_codes).toEqual(
      expect.arrayContaining([
        "topology_three_or_more_columns",
        "worker_in_leftmost_column",
      ]),
    );
    expect(leftWorkerHealth.issue_severities).toMatchObject({
      topology_three_or_more_columns: "blocking",
      worker_in_leftmost_column: "blocking",
    });
  });

  it("keeps the correct lead-left worker-right fixture healthy", async () => {
    const panes = [
      positionedPane("pane:left", 0, ["surface:lead-left"], 0),
      positionedPane("pane:right", 1, ["surface:worker-right"], 500),
    ];
    const groups: CmuxPaneSurfaces[] = [
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:left",
        surfaces: [surface("surface:lead-left", "cmuxlayerClaude-LEAD")],
      },
      {
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:right",
        surfaces: [surface("surface:worker-right", "cmuxlayerCodex W-A1")],
      },
    ];
    const snapshot = await collectSurfaceTopology(
      makeTopologyClient(panes, groups),
      "workspace:1",
    );
    expect(snapshot).not.toBeNull();
    const lead = makeRecord({ surface_id: "surface:lead-left", role: undefined });
    const worker = makeRecord({
      surface_id: "surface:worker-right",
      role: undefined,
    });

    expect(
      healthFor(lead, snapshot),
    ).toEqual({
      status: "healthy",
      issue_codes: [],
      issues: [],
    });
    expect(
      healthFor(worker, snapshot),
    ).toEqual({
      status: "healthy",
      issue_codes: [],
      issues: [],
    });
  });
});
