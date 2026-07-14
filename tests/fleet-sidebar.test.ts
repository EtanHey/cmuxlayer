import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentHealthIssueCode,
  AgentHealthIssueSeverity,
} from "../src/agent-health.js";
import {
  applyFleetSidebarCollapseState,
  buildFleetSidebarSnapshot,
  defaultFleetSidebarDevPath,
  defaultFleetSidebarCollapseStatePath,
  defaultFleetSidebarPath,
  FleetSidebarCollapseStore,
  FleetSidebarPublisher,
  renderFleetSidebar,
  toFleetScreenState,
  type FleetSidebarCandidate,
} from "../src/fleet-sidebar.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type ContentDietCandidate = FleetSidebarCandidate & {
  healthIssueCodes: AgentHealthIssueCode[];
  healthIssueSeverities: Partial<
    Record<AgentHealthIssueCode, AgentHealthIssueSeverity>
  >;
  screenCurrentAction: string | null;
};

function candidate(
  overrides: Partial<ContentDietCandidate> = {},
): ContentDietCandidate {
  return {
    agentId: "agent-1",
    agentType: "codex",
    agentState: "idle",
    lastProgressAtMs: null,
    surfaceRef: "surface:1",
    surfaceTitle: "cmuxlayerCodex [surface:1]",
    repo: "cmuxlayer",
    seatLane: null,
    seatId: null,
    launcherName: "cmuxlayerCodex",
    role: "worker",
    discovered: false,
    registryVersion: 1,
    registryUpdatedAt: "2026-07-13T10:00:00.000Z",
    createdAt: "2026-07-13T09:00:00.000Z",
    taskSummary: "Implement fleet sidebar",
    healthStatus: "healthy",
    healthReasons: [],
    healthIssueCodes: [],
    healthIssueSeverities: {},
    screenCurrentAction: null,
    screenStatus: "working",
    ...overrides,
  };
}

describe("fleet sidebar reconciled snapshot", () => {
  it("maps only current screen evidence to working, idle, or stalled", () => {
    expect(toFleetScreenState("thinking")).toBe("working");
    expect(toFleetScreenState("working")).toBe("working");
    expect(toFleetScreenState("idle")).toBe("idle");
    expect(toFleetScreenState("done")).toBe("idle");
    expect(toFleetScreenState("frozen")).toBe("stalled");
    expect(toFleetScreenState(null)).toBe("stalled");
    expect(toFleetScreenState(undefined)).toBe("stalled");
  });

  it("keeps a recently progressing registry-working lead active when screen parsing briefly reports idle", () => {
    const nowMs = Date.parse("2026-07-14T16:00:00.000Z");
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "orc-lead",
          surfaceTitle: "orcClaude LEAD",
          repo: "orc",
          role: "orchestrator",
          screenCurrentAction: "Bash(cat >> orchestra.md)",
          screenStatus: "idle",
          agentState: "working",
          lastProgressAtMs: nowMs - 5_000,
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:1"]),
        nowMs,
      },
    );

    expect(snapshot.lanes[0]).toMatchObject({
      key: "orc",
      activeCount: 1,
      collapsed: false,
    });
    expect(snapshot.lanes[0]?.seats[0]?.screenState).toBe("working");
  });

  it("renders working with no progress past the timeout as stalled", () => {
    const nowMs = Date.parse("2026-07-14T16:00:00.000Z");
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          screenStatus: "working",
          agentState: "working",
          lastProgressAtMs: nowMs - 120_001,
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:1"]),
        nowMs,
        workingNoProgressTimeoutMs: 120_000,
      },
    );

    expect(snapshot.lanes[0]?.seats[0]?.screenState).toBe("stalled");
  });

  it("excludes dead-surface ghosts before computing lane counts", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate(),
        candidate({
          agentId: "ghost",
          surfaceRef: "surface:dead",
          surfaceTitle: "golemsClaude [surface:dead]",
          repo: "golems",
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    expect(snapshot.seatCount).toBe(1);
    expect(snapshot.lanes).toHaveLength(1);
    expect(snapshot.lanes[0]).toMatchObject({
      key: "cmuxlayer",
      liveCount: 1,
      activeCount: 1,
    });
    expect(snapshot.lanes[0]?.seats.map((seat) => seat.surfaceRef)).toEqual([
      "surface:1",
    ]);
  });

  it("deduplicates by live surface and prefers managed registry evidence", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "auto-codex-surface-7",
          surfaceRef: "surface:7",
          surfaceTitle: "voicelayerCodex [surface:7]",
          repo: "voicelayer",
          discovered: true,
          registryVersion: 99,
          registryUpdatedAt: "2026-07-13T11:00:00.000Z",
          taskSummary: "(resync-repaired)",
        }),
        candidate({
          agentId: "voice-worker",
          surfaceRef: "surface:7",
          surfaceTitle: "voicelayerCodex [surface:7]",
          repo: "voicelayer",
          discovered: false,
          registryVersion: 3,
          registryUpdatedAt: "2026-07-13T10:30:00.000Z",
          taskSummary: "Review PR 330",
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:7"]) },
    );

    expect(snapshot.seatCount).toBe(1);
    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      agentId: "voice-worker",
      surfaceRef: "surface:7",
      status: "Review PR 330",
    });
  });

  it("uses the newest registry record when duplicate candidates have equal provenance", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "older",
          registryVersion: 5,
          registryUpdatedAt: "2026-07-13T10:00:00.000Z",
        }),
        candidate({
          agentId: "newer",
          registryVersion: 6,
          registryUpdatedAt: "2026-07-13T09:00:00.000Z",
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    expect(snapshot.lanes[0]?.seats[0]?.agentId).toBe("newer");
  });

  it("normalizes auto-discovered voicelayer and skillCreator seats into their lanes", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "auto-codex-surface-10",
          surfaceRef: "surface:10",
          surfaceTitle: "voicelayerCodex [surface:10]",
          repo: "unknown",
          launcherName: null,
          discovered: true,
        }),
        candidate({
          agentId: "auto-claude-surface-11",
          surfaceRef: "surface:11",
          surfaceTitle: "skillcreatorClaude-standing-reviewer",
          repo: "skillcreatorClaude-standing-reviewer",
          launcherName: null,
          discovered: true,
        }),
        candidate({
          agentId: "skill-creator-worker",
          surfaceRef: "surface:12",
          surfaceTitle: "skill-creatorCodex [surface:12]",
          repo: "skill-creator",
          launcherName: null,
        }),
      ],
      {
        liveSurfaceRefs: new Set([
          "surface:10",
          "surface:11",
          "surface:12",
        ]),
      },
    );

    expect(snapshot.lanes.map((lane) => [lane.key, lane.liveCount])).toEqual([
      ["voicelayer", 1],
      ["skillCreator", 2],
    ]);
  });

  it("normalizes mm launcher, repo, seat lane, and worktree identities into the mm lane", () => {
    const candidates = [
      candidate({
        agentId: "mm-launcher",
        surfaceRef: "surface:mm-launcher",
        surfaceTitle: "MM launcher worker",
        repo: "unknown",
        launcherName: "mmClaude",
      }),
      candidate({
        agentId: "mm-repo",
        surfaceRef: "surface:mm-repo",
        surfaceTitle: "repo worker",
        repo: "mm",
        launcherName: "mmCodex",
      }),
      candidate({
        agentId: "mm-seat",
        surfaceRef: "surface:mm-seat",
        surfaceTitle: "seat worker",
        repo: "unknown",
        seatLane: "mm",
        launcherName: null,
      }),
      candidate({
        agentId: "mm-worktree",
        surfaceRef: "surface:mm-worktree",
        surfaceTitle: "worktree worker",
        repo: "/Users/etanheyman/Gits/mm.wt/clickable-leads",
        launcherName: null,
      }),
      candidate({
        agentId: "contains-mm-only",
        surfaceRef: "surface:contains-mm-only",
        surfaceTitle: "summary worker",
        repo: "summary-tools",
        launcherName: null,
      }),
    ];

    const snapshot = buildFleetSidebarSnapshot(candidates, {
      liveSurfaceRefs: new Set(candidates.map((item) => item.surfaceRef)),
    });

    expect(snapshot.lanes.map((lane) => [lane.key, lane.liveCount])).toEqual([
      ["mm", 4],
      ["other", 1],
    ]);
  });

  it("sorts leads before workers and collapses only all-idle lanes", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "worker",
          surfaceRef: "surface:20",
          surfaceTitle: "golemsCodex",
          repo: "golems",
          role: "worker",
          screenStatus: "idle",
        }),
        candidate({
          agentId: "lead",
          surfaceRef: "surface:21",
          surfaceTitle: "golems LEAD",
          repo: "golems",
          role: "orchestrator",
          screenStatus: "idle",
        }),
        candidate({
          agentId: "stalled-worker",
          surfaceRef: "surface:22",
          surfaceTitle: "orcCodex",
          repo: "orc",
          role: "worker",
          screenStatus: null,
        }),
      ],
      {
        liveSurfaceRefs: new Set([
          "surface:20",
          "surface:21",
          "surface:22",
        ]),
      },
    );

    const golems = snapshot.lanes.find((lane) => lane.key === "golems");
    expect(golems).toMatchObject({
      liveCount: 2,
      activeCount: 0,
      collapsed: true,
    });
    expect(golems?.seats.map((seat) => seat.agentId)).toEqual([
      "lead",
      "worker",
    ]);

    const orc = snapshot.lanes.find((lane) => lane.key === "orc");
    expect(orc).toMatchObject({
      liveCount: 1,
      activeCount: 1,
      collapsed: false,
    });
  });

  it("suppresses info-tier health reasons from row content", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          healthStatus: "healthy",
          healthIssueCodes: [
            "auto_discovered_agent",
            "missing_cli_session_id",
            "non_resumable",
            "inbox_monitor_not_alive",
          ],
          healthReasons: [
            "agent was auto-discovered, not created through managed spawn_agent",
            "managed long-running agent has no cli_session_id",
            "agent cannot be resumed because no CLI session id was captured",
            "agent inbox monitor heartbeat is absent or stale",
          ],
          healthIssueSeverities: {
            auto_discovered_agent: "info",
            missing_cli_session_id: "info",
            non_resumable: "info",
            inbox_monitor_not_alive: "info",
          },
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      healthVisible: false,
      health: "",
    });
  });

  it("preserves only full actionable degraded and blocking health reasons", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          healthStatus: "unhealthy",
          healthIssueCodes: [
            "auto_discovered_agent",
            "inbox_monitor_not_alive",
            "agent_wedged",
          ],
          healthReasons: [
            "agent was auto-discovered, not created through managed spawn_agent",
            "agent inbox monitor heartbeat is absent or stale",
            "agent screen and registry heartbeat are both stale and require operator recovery",
          ],
          healthIssueSeverities: {
            auto_discovered_agent: "info",
            inbox_monitor_not_alive: "degraded",
            agent_wedged: "blocking",
          },
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      healthVisible: true,
      health:
        "agent screen and registry heartbeat are both stale and require operator recovery",
    });
  });

  it("suppresses registry binding artifacts even when their diagnostic severity is blocking", () => {
    const bindingReasons = [
      "spawned agent seat identity does not match the registry",
      "non-Claude agent was assigned orchestrator topology role",
      "orchestrator is not in the leftmost column",
      "worker is in the leftmost lead column",
      "registry workspace does not match the surface workspace",
    ];
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          healthStatus: "unhealthy",
          healthIssueCodes: [
            "seat_identity_mismatch",
            "non_claude_orchestrator",
            "orchestrator_not_leftmost",
            "worker_in_leftmost_column",
            "registry_surface_workspace_mismatch",
          ],
          healthReasons: bindingReasons,
          healthIssueSeverities: {
            seat_identity_mismatch: "blocking",
            non_claude_orchestrator: "blocking",
            orchestrator_not_leftmost: "blocking",
            worker_in_leftmost_column: "blocking",
            registry_surface_workspace_mismatch: "blocking",
          },
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      healthVisible: false,
      health: "",
    });
    const source = renderFleetSidebar(snapshot);
    for (const reason of bindingReasons) {
      expect(source).not.toContain(reason);
    }
  });

  it("uses a subtle no-status marker for missing and repair-placeholder status", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [candidate({ taskSummary: "(resync-repaired)" })],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      status: "— no status",
      statusMissing: true,
    });
  });

  it("prefers set status, then parsed action, while the idle glyph stays truthful", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "manual",
          surfaceRef: "surface:1",
          taskSummary: "Ship the content diet",
          screenCurrentAction: "Running tests",
        }),
        candidate({
          agentId: "parsed",
          surfaceRef: "surface:2",
          taskSummary: "(auto-discovered)",
          screenCurrentAction: "Editing src/fleet-sidebar.ts",
          screenStatus: "idle",
        }),
        candidate({
          agentId: "empty",
          surfaceRef: "surface:3",
          taskSummary: null,
          screenCurrentAction: null,
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:1", "surface:2", "surface:3"]),
      },
    );

    const byAgent = new Map(
      snapshot.lanes[0]?.seats.map((seat) => [seat.agentId, seat]),
    );
    expect(byAgent.get("manual")).toMatchObject({
      status: "Ship the content diet",
      statusMissing: false,
    });
    expect(byAgent.get("parsed")).toMatchObject({
      screenState: "idle",
      status: "Editing src/fleet-sidebar.ts",
      statusMissing: false,
    });
    expect(byAgent.get("empty")).toMatchObject({
      status: "— no status",
      statusMissing: true,
    });
  });
});

describe("fleet sidebar snapshot to interpreted Swift", () => {
  it("applies independent persisted collapse state to active lanes", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "skill-lead",
          surfaceRef: "surface:skill-lead",
          surfaceTitle: "skillCreator LEAD",
          repo: "skill-creator",
          role: "orchestrator",
        }),
        candidate({
          agentId: "skill-worker",
          surfaceRef: "surface:skill-worker",
          surfaceTitle: "skillCreatorCodex",
          repo: "skill-creator",
        }),
        candidate({
          agentId: "cmux-lead",
          surfaceRef: "surface:cmux-lead",
          surfaceTitle: "cmuxlayer LEAD",
          repo: "cmuxlayer",
          role: "orchestrator",
        }),
        candidate({
          agentId: "cmux-worker",
          surfaceRef: "surface:cmux-worker",
          surfaceTitle: "cmuxlayerCodex",
          repo: "cmuxlayer",
        }),
      ],
      {
        liveSurfaceRefs: new Set([
          "surface:skill-lead",
          "surface:skill-worker",
          "surface:cmux-lead",
          "surface:cmux-worker",
        ]),
      },
    );

    const collapsed = applyFleetSidebarCollapseState(snapshot, {
      skillCreator: true,
      cmuxlayer: false,
    });

    expect(
      collapsed.lanes.find((lane) => lane.key === "skillCreator")?.collapsed,
    ).toBe(true);
    expect(
      collapsed.lanes.find((lane) => lane.key === "cmuxlayer")?.collapsed,
    ).toBe(false);
    expect(collapsed.lanes.every((lane) => lane.activeCount > 0)).toBe(true);
  });

  it("always renders a collapsed lane's lead identity, one-line status, counts, and hidden-seat total", () => {
    const leadAction =
      "Coordinating the complete sidebar render-polish delivery across Claude wake detection, full-topology republishing, isolated fleet-dev preview output, collapsed-lane lead summaries, and final verification without allowing this intentionally overflowing status to add another row";
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "lead",
          surfaceRef: "surface:lead",
          surfaceTitle: "cmuxlayerClaude LEAD",
          repo: "cmuxlayer",
          role: "orchestrator",
          taskSummary: null,
          screenCurrentAction: leadAction,
        }),
        candidate({
          agentId: "worker",
          surfaceRef: "surface:worker",
          surfaceTitle: "cmuxlayerCodex",
          repo: "cmuxlayer",
          taskSummary: "Implement collapse",
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:lead", "surface:worker"]),
      },
    );
    const source = renderFleetSidebar(
      applyFleetSidebarCollapseState(snapshot, { cmuxlayer: true }),
    );

    expect(source).toContain('fleetLane("cmuxlayer", 2, 2, true, 2, [');
    expect(source).toContain('"name": "cmuxlayerClaude LEAD"');
    expect(leadAction.length).toBeGreaterThan(200);
    expect(source).toContain(`"status": ${JSON.stringify(leadAction)}`);
    expect(source).toContain('Text("\\(liveCount) live · \\(activeCount) active")');
    expect(source).toContain('Text("\\(hiddenSeatCount) seats hidden")');
    expect(source).toContain("fleetLeadSummary(lead)");
    const leadStatusBlock = source.slice(
      source.indexOf("Text(lead.status)"),
      source.indexOf("      Spacer()", source.indexOf("Text(lead.status)")),
    );
    expect(leadStatusBlock).toContain(".lineLimit(1)");
    expect(leadStatusBlock).toContain(".truncationMode(.tail)");
    expect(source).not.toContain('"surfaceRef": "surface:lead"');
    expect(source).not.toContain('"surfaceRef": "surface:worker"');
  });

  it("focuses a collapsed present lead by its stable surface UUID", () => {
    const surfaceUuid = "7A8B9C0D-1111-4222-8333-444455556666";
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "lead",
          surfaceUuid,
          surfaceRef: "surface:lead",
          surfaceTitle: "cmuxlayerClaude LEAD",
          role: "orchestrator",
          screenStatus: "idle",
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:lead"]),
        liveSurfaceUuids: new Set([surfaceUuid]),
      },
    );

    const source = renderFleetSidebar(snapshot);
    expect(snapshot.lanes[0]?.collapsed).toBe(true);
    expect(source).toContain(`"surfaceUuid": "${surfaceUuid}"`);
    const leadSummaryBlock = source.slice(
      source.indexOf("func fleetLeadSummary"),
      source.indexOf("func fleetLaneHeader"),
    );
    expect(leadSummaryBlock).toContain(
      'Button(action: { cmux("surface.focus", surface_id: lead.surfaceUuid) })',
    );
  });

  it("keeps a collapsed lead without a stable UUID non-interactive", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "legacy-lead",
          surfaceRef: "surface:legacy-lead",
          surfaceTitle: "cmuxlayerClaude LEAD",
          role: "orchestrator",
          screenStatus: "idle",
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:legacy-lead"]) },
    );

    const source = renderFleetSidebar(snapshot);
    expect(snapshot.lanes[0]?.collapsed).toBe(true);
    expect(source).toContain('"surfaceUuid": ""');
    const leadSummaryBlock = source.slice(
      source.indexOf("func fleetLeadSummary"),
      source.indexOf("func fleetLaneHeader"),
    );
    expect(leadSummaryBlock).toContain(
      "if lead.present && !lead.surfaceUuid.isEmpty",
    );
    expect(source).not.toContain(
      'cmux("surface.focus", surface_id: "")',
    );
  });

  it("renders every card for the same lane when explicitly expanded", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "lead",
          surfaceRef: "surface:lead",
          surfaceTitle: "cmuxlayer LEAD",
          role: "orchestrator",
        }),
        candidate({
          agentId: "worker",
          surfaceRef: "surface:worker",
          surfaceTitle: "cmuxlayerCodex",
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:lead", "surface:worker"]),
      },
    );
    const source = renderFleetSidebar(
      applyFleetSidebarCollapseState(snapshot, { cmuxlayer: false }),
    );

    expect(source).toContain('fleetLane("cmuxlayer", 2, 2, false, 0, [');
    expect(source).toContain('"surfaceRef": "surface:lead"');
    expect(source).toContain('"surfaceRef": "surface:worker"');
  });

  it("shrinks a 15 live and 3 active topology to compact lane summaries", () => {
    const laneSpecs = [
      { repo: "orc", count: 1, active: 0 },
      { repo: "golems", count: 2, active: 0 },
      { repo: "voicelayer", count: 2, active: 0 },
      { repo: "skill-creator", count: 3, active: 1 },
      { repo: "cmuxlayer", count: 6, active: 2 },
      { repo: "misc", count: 1, active: 0 },
    ] as const;
    const candidates = laneSpecs.flatMap((spec) =>
      Array.from({ length: spec.count }, (_, index) => {
        const surfaceRef = `surface:${spec.repo}:${index}`;
        return candidate({
          agentId: `${spec.repo}-${index}`,
          surfaceRef,
          surfaceTitle:
            index === 0
              ? `${spec.repo} LEAD`
              : `${spec.repo} worker ${index}`,
          repo: spec.repo,
          role: index === 0 ? "orchestrator" : "worker",
          screenStatus: index < spec.active ? "working" : "idle",
          taskSummary: `Long representative status for ${spec.repo} seat ${index}`,
        });
      }),
    );
    const snapshot = buildFleetSidebarSnapshot(candidates, {
      liveSurfaceRefs: new Set(candidates.map((item) => item.surfaceRef)),
    });
    expect(snapshot).toMatchObject({ seatCount: 15, activeCount: 3 });

    const expanded = renderFleetSidebar(
      applyFleetSidebarCollapseState(snapshot, {
        orc: false,
        golems: false,
        voicelayer: false,
        skillCreator: false,
        cmuxlayer: false,
        other: false,
      }),
    );
    const compact = renderFleetSidebar(
      applyFleetSidebarCollapseState(snapshot, {
        orc: true,
        golems: true,
        voicelayer: true,
        skillCreator: true,
        cmuxlayer: true,
        other: true,
      }),
    );

    expect(expanded.match(/"surfaceRef":/g)).toHaveLength(15);
    expect(compact.match(/"surfaceRef":/g) ?? []).toHaveLength(0);
    expect(compact.length).toBeLessThan(expanded.length * 0.6);
    expect(compact).toContain('Text("15 live seats · 3 active")');
  });

  it("renders exact counts and click-to-focus actions for the final live rows", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          surfaceUuid: "11111111-2222-4333-8444-555555555555",
          surfaceRef: "surface:7",
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:7"]) },
    );

    const source = renderFleetSidebar(snapshot);

    expect(source).toContain('fleetLane("cmuxlayer", 1, 1, false, 0, [');
    expect(source).toContain(
      'cmux("surface.focus", surface_id: seat.surfaceUuid)',
    );
    expect(source).toContain(
      '"surfaceUuid": "11111111-2222-4333-8444-555555555555"',
    );
    expect(source).toContain('"surfaceRef": "surface:7"');
  });

  it("tints Claude rows orange, Codex rows blue, and other engines neutral without changing state dots", () => {
    const candidates = [
      candidate({
        agentId: "claude-worker",
        surfaceRef: "surface:claude",
        surfaceTitle: "cmuxlayerClaude",
        agentType: "claude",
        screenStatus: "working",
      }),
      candidate({
        agentId: "codex-worker",
        surfaceRef: "surface:codex",
        surfaceTitle: "cmuxlayerCodex",
        agentType: "codex",
        screenStatus: "idle",
      }),
      candidate({
        agentId: "gemini-worker",
        surfaceRef: "surface:gemini",
        surfaceTitle: "cmuxlayerGemini",
        agentType: "gemini",
        screenStatus: "frozen",
      }),
    ];
    const snapshot = buildFleetSidebarSnapshot(candidates, {
      liveSurfaceRefs: new Set(candidates.map((item) => item.surfaceRef)),
    });
    const source = renderFleetSidebar(
      applyFleetSidebarCollapseState(snapshot, { cmuxlayer: false }),
    );

    expect(source).toContain('"agentType": "claude"');
    expect(source).toContain('"agentType": "codex"');
    expect(source).toContain('"agentType": "gemini"');
    const tintBlock = source.slice(
      source.indexOf("func fleetAgentTint"),
      source.indexOf("func fleetState"),
    );
    expect(tintBlock).toContain(
      'if agentType == "claude" { return "#F59E0B" }',
    );
    expect(tintBlock).toContain(
      'if agentType == "codex" { return "#3B82F6" }',
    );
    expect(tintBlock).toContain('return "#6B7280"');
    const rowBlock = source.slice(
      source.indexOf("func fleetRow"),
      source.indexOf("func fleetLeadSummaryContent"),
    );
    expect(rowBlock).toContain(
      ".foregroundColor(fleetAgentTint(seat.agentType))",
    );
    const stateBlock = source.slice(
      source.indexOf("func fleetState"),
      source.indexOf("func fleetRow"),
    );
    expect(stateBlock).toContain(
      'Text("●").foregroundColor("#3B82F6")',
    );
    expect(stateBlock).toContain(
      'Text("●").foregroundColor("#6B7280")',
    );
    expect(stateBlock).toContain(
      'Text("●").foregroundColor("#EF4444")',
    );
  });

  it("projects agent type into collapsed leads and tints their background", () => {
    const surfaceUuid = "3A4B5C6D-7777-4888-8999-AAAABBBBCCCC";
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          agentId: "claude-lead",
          surfaceUuid,
          surfaceRef: "surface:claude-lead",
          surfaceTitle: "cmuxlayerClaude LEAD",
          agentType: "claude",
          role: "orchestrator",
          screenStatus: "idle",
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:claude-lead"]),
        liveSurfaceUuids: new Set([surfaceUuid]),
      },
    );

    const source = renderFleetSidebar(snapshot);
    expect(snapshot.lanes[0]?.collapsed).toBe(true);
    expect(source).toContain('"agentType": "claude"');
    const leadSummaryBlock = source.slice(
      source.indexOf("func fleetLeadSummaryContent"),
      source.indexOf("func fleetLaneHeader"),
    );
    expect(leadSummaryBlock).toContain(
      ".foregroundColor(fleetAgentTint(lead.agentType))",
    );
  });

  it("renders a never-active seat as stalled but immediately focusable by UUID", () => {
    const surfaceUuid = "078D1A5B-A3F4-40A5-8A59-A6C840BAF832";
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          surfaceUuid,
          surfaceRef: "surface:591",
          screenStatus: null,
          taskSummary: "",
        }),
      ],
      {
        liveSurfaceRefs: new Set(["surface:591"]),
        liveSurfaceUuids: new Set([surfaceUuid]),
      },
    );

    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      surfaceUuid,
      surfaceRef: "surface:591",
      screenState: "stalled",
    });
    const source = renderFleetSidebar(snapshot);
    expect(source).toContain(
      'cmux("surface.focus", surface_id: seat.surfaceUuid)',
    );
    expect(source).toContain(`"surfaceUuid": "${surfaceUuid}"`);
  });

  it("emits row data as Swift dictionaries instead of JSON object closures", () => {
    const source = renderFleetSidebar(
      buildFleetSidebarSnapshot([candidate()], {
        liveSurfaceRefs: new Set(["surface:1"]),
      }),
    );

    expect(source).toContain('    [\n      "agentId": "agent-1"');
    expect(source).not.toContain('    {\n      "agentId": "agent-1"');
  });

  it("defines stateable glyphs and automatic idle-lane collapse without decorative bars", () => {
    const source = renderFleetSidebar(
      buildFleetSidebarSnapshot(
        [
          candidate({ surfaceRef: "surface:1", screenStatus: "working" }),
          candidate({ surfaceRef: "surface:2", screenStatus: "idle" }),
          candidate({ surfaceRef: "surface:3", screenStatus: "frozen" }),
        ],
        {
          liveSurfaceRefs: new Set([
            "surface:1",
            "surface:2",
            "surface:3",
          ]),
        },
      ),
    );

    expect(source).toContain('if state == "working"');
    expect(source).toContain('if state == "idle"');
    expect(source).toContain('if collapsed');
    expect(source).toContain('Text("working")');
    expect(source).toContain('Text("idle")');
    expect(source).toContain('Text("stalled")');
    expect(source).not.toContain("ProgressView");
    expect(source).not.toContain("Gauge");
  });

  it("renders lane collapse state without a clickable-looking caret", () => {
    const source = renderFleetSidebar(
      buildFleetSidebarSnapshot([candidate()], {
        liveSurfaceRefs: new Set(["surface:1"]),
      }),
    );

    expect(source).toContain(
      'Text(collapsed ? "collapsed" : "expanded")',
    );
    expect(source).toContain(
      '.help(collapsed ? "Run cmuxlayer fleet-sidebar expand \\(name)" : "Run cmuxlayer fleet-sidebar collapse \\(name)")',
    );
    expect(source).toContain(
      'Text(collapsed ? "CLI · cmuxlayer fleet-sidebar expand \\(name)" : "CLI · cmuxlayer fleet-sidebar collapse \\(name)")',
    );
    const laneHeaderBlock = source.slice(
      source.indexOf("func fleetLaneHeader"),
      source.indexOf("func fleetLane("),
    );
    expect(laneHeaderBlock).not.toContain("Button(");
    expect(source).not.toContain("▸");
    expect(source).not.toContain("▾");
  });

  it("preserves Swift interpolation escapes inside the generated helper source", () => {
    const source = renderFleetSidebar({
      seatCount: 0,
      activeCount: 0,
      lanes: [],
    });

    expect(source).toContain('return "seat \\(age / 86400)d"');
    expect(source).toContain('Text("health: \\(seat.health)")');
    expect(source).toContain(
      'Text("\\(liveCount) live · \\(activeCount) active")',
    );
    expect(source).toContain('Text("\\(hiddenSeatCount) seats hidden")');
  });

  it("caps a long screen-derived action while leaving actionable health multiline", () => {
    const screenCurrentAction =
      "Analyzing the sidebar wake-republish path across every active fleet lane while preserving the last populated snapshot through coalesced writes, first-paint discovery protection, and delayed screen-state reconciliation without allowing the status row to grow taller";
    const health = "בריאות מלאה — reason must wrap";
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          taskSummary: "(unknown)",
          screenCurrentAction,
          healthStatus: "unhealthy",
          healthIssueCodes: ["agent_wedged"],
          healthReasons: [health],
          healthIssueSeverities: { agent_wedged: "blocking" },
        }),
        candidate({
          agentId: "lead-1",
          surfaceRef: "surface:2",
          surfaceTitle: "cmuxlayer lead",
          role: "orchestrator",
          taskSummary: null,
          screenCurrentAction,
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1", "surface:2"]) },
    );

    const source = renderFleetSidebar(snapshot);

    expect(screenCurrentAction.length).toBeGreaterThan(200);
    expect(
      snapshot.lanes[0]?.seats.every(
        (seat) => seat.status === screenCurrentAction,
      ),
    ).toBe(true);
    expect(source).toContain(
      `"status": ${JSON.stringify(screenCurrentAction)}`,
    );
    expect(source).toContain(`"health": ${JSON.stringify(health)}`);
    expect(source).not.toContain(".fixedSize");
    const seatStatusBlock = source.slice(
      source.indexOf("Text(seat.status)"),
      source.indexOf("if seat.healthVisible"),
    );
    const leadStatusBlock = source.slice(
      source.indexOf("Text(lead.status)"),
      source.indexOf("      Spacer()", source.indexOf("Text(lead.status)")),
    );
    for (const statusBlock of [seatStatusBlock, leadStatusBlock]) {
      expect(statusBlock).toContain(".lineLimit(1)");
      expect(statusBlock).toContain(".truncationMode(.tail)");
    }
    const healthBlock = source.slice(
      source.indexOf("if seat.healthVisible"),
      source.indexOf("    }\n    .padding(6)"),
    );
    expect(healthBlock).not.toContain(".lineLimit");
    expect(healthBlock).not.toContain(".truncationMode");
  });

  it("renders missing status dimly and gates health on actionable visibility", () => {
    const source = renderFleetSidebar(
      buildFleetSidebarSnapshot(
        [
          candidate({
            taskSummary: " ",
            healthStatus: "healthy",
            healthIssueCodes: ["auto_discovered_agent"],
            healthReasons: [
              "agent was auto-discovered, not created through managed spawn_agent",
            ],
            healthIssueSeverities: { auto_discovered_agent: "info" },
          }),
        ],
        { liveSurfaceRefs: new Set(["surface:1"]) },
      ),
    );

    expect(source).toContain('"status": "— no status"');
    expect(source).not.toContain("STATUS NOT SET");
    expect(source).toContain(
      ".foregroundColor(seat.statusMissing ? .tertiary : .secondary)",
    );
    expect(source).toContain("if seat.healthVisible");
    expect(source).toContain('"healthVisible": false');
  });

  it("uses default text wrapping inside an explicit vertical scroll view", () => {
    const source = renderFleetSidebar({
      seatCount: 0,
      activeCount: 0,
      lanes: [],
    });

    expect(source).toContain("ScrollView {\nVStack(alignment: .leading");
    expect(source).not.toContain(".fixedSize");
  });

  it("renders an explicit discovery placeholder for an empty fleet state", () => {
    const source = renderFleetSidebar({
      seatCount: 0,
      activeCount: 0,
      lanes: [],
    });

    expect(source).toContain('Text("Discovering fleet seats…")');
    expect(source).toContain(
      'Text("Reconnect discovery populates this view automatically.")',
    );
    expect(source).not.toContain('Text("No live fleet seats")');
    expect(source).toContain('Text("0 live seats · 0 active")');
    expect(source).toContain(
      "cmuxlayer-fleet-state: discovering rendered=0 observed=unknown",
    );
  });

  it("distinguishes authoritative empty and unknown topology placeholders", () => {
    const snapshot = { seatCount: 0, activeCount: 0, lanes: [] };
    const empty = renderFleetSidebar(snapshot, { state: "empty" });
    const unknown = renderFleetSidebar(snapshot, { state: "unknown" });

    expect(empty).toContain('Text("No live fleet seats")');
    expect(empty).not.toContain('Text("Discovering fleet seats…")');
    expect(unknown).toContain('Text("Fleet topology unavailable")');
    expect(unknown).not.toContain('Text("No live fleet seats")');
  });
});

describe("fleet sidebar atomic publisher", () => {
  function tempOutputPath(): string {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-fleet-sidebar-"));
    tempDirs.push(root);
    return join(root, ".config", "cmux", "sidebars", "fleet.swift");
  }

  function snapshotWithStatus(status: string) {
    return buildFleetSidebarSnapshot(
      [candidate({ taskSummary: status })],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );
  }

  function snapshotWithSurfaces(surfaceRefs: string[]) {
    return buildFleetSidebarSnapshot(
      surfaceRefs.map((surfaceRef, index) =>
        candidate({
          agentId: `agent-${index + 1}`,
          surfaceRef,
          surfaceTitle: `cmuxlayerCodex [${surfaceRef}]`,
        }),
      ),
      { liveSurfaceRefs: new Set(surfaceRefs) },
    );
  }

  function publication(
    state: "discovering" | "populated" | "empty" | "unknown",
    surfaceRefs: string[],
    observedLiveSurfaceRefs: string[] | null,
  ) {
    return {
      state,
      snapshot: snapshotWithSurfaces(surfaceRefs),
      observedLiveSurfaceRefs,
    };
  }

  function uuidPublication(
    surfaceRef: string,
    surfaceUuid: string,
  ) {
    return {
      state: "populated" as const,
      snapshot: buildFleetSidebarSnapshot(
        [candidate({ surfaceRef, surfaceUuid })],
        {
          liveSurfaceRefs: new Set([surfaceRef]),
          liveSurfaceUuids: new Set([surfaceUuid]),
        },
      ),
      observedLiveSurfaceRefs: [surfaceRef],
      observedLiveSurfaceUuids: [surfaceUuid],
    };
  }

  it("uses the canonical home-relative output path", () => {
    expect(defaultFleetSidebarPath("/tmp/example-home")).toBe(
      "/tmp/example-home/.config/cmux/sidebars/fleet.swift",
    );
  });

  it("uses a separate discoverable fleet-dev path for development previews", () => {
    expect(defaultFleetSidebarDevPath("/tmp/example-home")).toBe(
      "/tmp/example-home/.config/cmux/sidebars/fleet-dev.swift",
    );
  });

  it("requires tests to inject a non-production publisher output path", () => {
    expect(() => new FleetSidebarPublisher()).toThrow(/explicit outputPath/i);
    expect(
      () =>
        new FleetSidebarPublisher({ outputPath: defaultFleetSidebarPath() }),
    ).toThrow(/non-production outputPath/i);
  });

  it("keeps collapse preferences outside cmux's discoverable sidebars directory", () => {
    expect(defaultFleetSidebarCollapseStatePath("/tmp/example-home")).toBe(
      "/tmp/example-home/.local/state/cmuxlayer/fleet-sidebar-collapse.json",
    );
  });

  it("isolates implicit collapse state beside a custom output path", () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    const publisherHarness = publisher as unknown as {
      collapseStore: FleetSidebarCollapseStore;
    };

    expect(publisherHarness.collapseStore.getStatePath()).toBe(
      `${outputPath}.collapse.json`,
    );
    publisher.dispose();

  });

  it("persists independent lane choices across collapse-store instances", () => {
    const outputPath = tempOutputPath();
    const statePath = join(outputPath, "..", "fleet-collapse.json");
    const first = new FleetSidebarCollapseStore({ statePath });

    first.setLaneCollapsed("skillCreator", true);
    first.setLaneCollapsed("cmuxlayer", false);

    const reloaded = new FleetSidebarCollapseStore({ statePath });
    expect(reloaded.read()).toEqual({
      skillCreator: true,
      cmuxlayer: false,
    });
    expect(reloaded.toggleLane("cmuxlayer")).toBe(true);
    expect(new FleetSidebarCollapseStore({ statePath }).read()).toEqual({
      skillCreator: true,
      cmuxlayer: true,
    });
  });

  it.each(["set", "toggle"] as const)(
    "preserves different lane updates across contending processes for %s",
    async (action) => {
      const outputPath = tempOutputPath();
      const statePath = join(outputPath, "..", "fleet-collapse.json");
      const lockPath = `${statePath}.lock`;
      mkdirSync(lockPath, { recursive: true });
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const { rmSync, writeFileSync } = require("node:fs");
setTimeout(() => {
  writeFileSync(process.argv[1], JSON.stringify({ version: 1, lanes: { skillCreator: true } }));
  rmSync(process.argv[2], { recursive: true, force: true });
}, 100);`,
          statePath,
          lockPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let childError = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        childError += chunk;
      });
      const childCompleted = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else {
            reject(
              new Error(`contention fixture exited ${code}: ${childError}`),
            );
          }
        });
      });

      const contendingStore = new FleetSidebarCollapseStore({ statePath });
      if (action === "set") {
        contendingStore.setLaneCollapsed("cmuxlayer", true);
      } else {
        expect(contendingStore.toggleLane("cmuxlayer", false)).toBe(true);
      }
      await childCompleted;

      expect(new FleetSidebarCollapseStore({ statePath }).read()).toEqual({
        skillCreator: true,
        cmuxlayer: true,
      });
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it("does not release a replacement lock when a quarantined owner resumes", async () => {
    const outputPath = tempOutputPath();
    const statePath = join(outputPath, "..", "fleet-collapse.json");
    const lockPath = `${statePath}.lock`;
    const acquiredPath = join(outputPath, "..", "old-lock-acquired");
    const releasedPath = join(outputPath, "..", "old-lock-released");
    const moduleUrl = new URL("../src/fleet-sidebar.ts", import.meta.url).href;
    const child = spawn(
      "bun",
      [
        "-e",
        `import { writeFileSync } from "node:fs";
import { FleetSidebarCollapseStore } from ${JSON.stringify(moduleUrl)};
const store = new FleetSidebarCollapseStore({ statePath: process.argv[1] });
store["withMutationLock"](() => {
  writeFileSync(process.argv[2], "acquired");
  process.kill(process.pid, "SIGSTOP");
});
writeFileSync(process.argv[3], "released");`,
        statePath,
        acquiredPath,
        releasedPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let childError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      childError += chunk;
    });
    const childCompleted = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`lock owner exited ${code}: ${childError}`));
      });
    });
    void childCompleted.catch(() => undefined);
    const waitForFile = (path: string): void => {
      const startedAt = Date.now();
      while (!existsSync(path)) {
        if (Date.now() - startedAt >= 2_000) {
          throw new Error(`Timed out waiting for fixture file: ${path}`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    };

    try {
      waitForFile(acquiredPath);
      const staleTime = new Date(Date.now() - 5_000);
      utimesSync(lockPath, staleTime, staleTime);
      const replacementStore = new FleetSidebarCollapseStore({ statePath });
      const lockHarness = replacementStore as unknown as {
        withMutationLock<T>(mutate: () => T): T;
      };

      lockHarness.withMutationLock(() => {
        process.kill(child.pid!, "SIGCONT");
        waitForFile(releasedPath);
        expect(existsSync(lockPath)).toBe(true);
      });
      await childCompleted;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (child.exitCode === null) {
        process.kill(child.pid!, "SIGCONT");
        child.kill("SIGKILL");
      }
    }
  });

  it("applies persisted collapse state before publishing an unchanged snapshot", () => {
    const outputPath = tempOutputPath();
    const statePath = join(outputPath, "..", "fleet-collapse.json");
    const store = new FleetSidebarCollapseStore({ statePath });
    const publisher = new FleetSidebarPublisher({
      outputPath,
      collapseStore: store,
    });
    const snapshot = snapshotWithStatus("active lane can collapse");

    store.setLaneCollapsed("cmuxlayer", true);
    publisher.publish(snapshot);

    const source = readFileSync(outputPath, "utf8");
    expect(source).toContain('fleetLane("cmuxlayer", 1, 1, true, 1, [');
    expect(source).not.toContain('"surfaceRef": "surface:1"');
    publisher.dispose();
  });

  it("republishes the cached snapshot promptly when CLI state changes", async () => {
    const outputPath = tempOutputPath();
    const statePath = join(outputPath, "..", "fleet-collapse.json");
    const store = new FleetSidebarCollapseStore({ statePath });
    const publisher = new FleetSidebarPublisher({
      outputPath,
      collapseStore: store,
    });

    try {
      publisher.publish(snapshotWithStatus("collapse without waiting for sweep"));
      expect(readFileSync(outputPath, "utf8")).toContain(
        '"surfaceRef": "surface:1"',
      );

      new FleetSidebarCollapseStore({ statePath }).setLaneCollapsed(
        "cmuxlayer",
        true,
      );
      const deadline = Date.now() + 1_200;
      while (
        Date.now() < deadline &&
        readFileSync(outputPath, "utf8").includes(
          '"surfaceRef": "surface:1"',
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const source = readFileSync(outputPath, "utf8");
      expect(source).toContain('fleetLane("cmuxlayer", 1, 1, true, 1, [');
      expect(source).not.toContain('"surfaceRef": "surface:1"');
    } finally {
      publisher.dispose();
    }
  });

  it("creates the target atomically and leaves no temporary file", () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });

    publisher.publish(snapshotWithStatus("first"));

    expect(readFileSync(outputPath, "utf8")).toContain('"status": "first"');
    expect(readdirSync(join(outputPath, ".."))).toEqual(["fleet.swift"]);
    publisher.dispose();
  });

  it("preserves a populated last-good source while topology is unknown", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );
    const lastGood = readFileSync(outputPath, "utf8");

    publisher.publish(
      publication("unknown", ["surface:1"], ["surface:1", "surface:2"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);
    publisher.dispose();
  });

  it("preserves the last-good UUID topology when a complete scan has mixed identity coverage", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    const firstUuid = "033F0B64-780F-4F0B-BCF1-3B8E085A7383";
    const secondUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
    publisher.publish({
      state: "populated",
      snapshot: buildFleetSidebarSnapshot(
        [
          candidate({ surfaceRef: "surface:594", surfaceUuid: firstUuid }),
          candidate({
            agentId: "agent-2",
            surfaceRef: "surface:595",
            surfaceUuid: secondUuid,
          }),
        ],
        {
          liveSurfaceRefs: new Set(["surface:594", "surface:595"]),
          liveSurfaceUuids: new Set([firstUuid, secondUuid]),
        },
      ),
      observedLiveSurfaceRefs: ["surface:594", "surface:595"],
      observedLiveSurfaceUuids: [firstUuid, secondUuid],
    });
    const lastGood = readFileSync(outputPath, "utf8");

    publisher.publish({
      state: "populated",
      snapshot: buildFleetSidebarSnapshot(
        [candidate({ surfaceRef: "surface:594", surfaceUuid: firstUuid })],
        {
          liveSurfaceRefs: new Set(["surface:594", "surface:595"]),
          liveSurfaceUuids: new Set([firstUuid]),
        },
      ),
      observedLiveSurfaceRefs: ["surface:594", "surface:595"],
      observedLiveSurfaceUuids: [firstUuid],
    });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);
    publisher.dispose();
  });

  it("replaces a populated row when a ref is recycled for a new UUID", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    const oldUuid = "033F0B64-780F-4F0B-BCF1-3B8E085A7383";
    const newUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
    publisher.publish(uuidPublication("surface:594", oldUuid));
    expect(readFileSync(outputPath, "utf8")).toContain(oldUuid);

    await new Promise((resolve) => setTimeout(resolve, 550));
    publisher.publish(uuidPublication("surface:594", newUuid));

    const source = readFileSync(outputPath, "utf8");
    expect(source).toContain(newUuid);
    expect(source).not.toContain(oldUuid);
    publisher.dispose();
  });

  it("rejects a populated decrease while omitted seat surfaces remain live", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );
    const lastGood = readFileSync(outputPath, "utf8");

    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1", "surface:2"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);
    publisher.dispose();
  });

  it("rejects a populated decrease over a collapsed source while omitted seats remain live", async () => {
    const outputPath = tempOutputPath();
    const statePath = join(outputPath, "..", "fleet-collapse.json");
    const store = new FleetSidebarCollapseStore({ statePath });
    store.setLaneCollapsed("cmuxlayer", true);
    const publisher = new FleetSidebarPublisher({
      outputPath,
      collapseStore: store,
    });
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );
    const lastGood = readFileSync(outputPath, "utf8");
    expect(lastGood).not.toContain('"surfaceRef":');
    expect(lastGood).toContain('surfaces=["surface:1","surface:2"]');

    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1", "surface:2"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);
    publisher.dispose();
  });

  it("keeps the last authoritative topology when collapse changes after a pending decrease is canceled", async () => {
    const outputPath = tempOutputPath();
    const statePath = join(outputPath, "..", "fleet-collapse.json");
    const store = new FleetSidebarCollapseStore({ statePath });
    const publisher = new FleetSidebarPublisher({
      outputPath,
      collapseStore: store,
    });
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );

    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1"]),
    );
    publisher.publish(
      publication(
        "populated",
        ["surface:1"],
        ["surface:1", "surface:2"],
      ),
    );
    store.setLaneCollapsed("cmuxlayer", true);
    const collapsedLane = 'fleetLane("cmuxlayer", 2, 2, true, 2, [';
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      !readFileSync(outputPath, "utf8").includes(collapsedLane)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const source = readFileSync(outputPath, "utf8");
    expect(source).toContain(
      "cmuxlayer-fleet-state: populated rendered=2 observed=2",
    );
    expect(source).toContain(collapsedLane);
    expect(source).not.toContain("rendered=1");
    publisher.dispose();
  });

  it("accepts a populated decrease after omitted seat surfaces disappear", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 550));
    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1"]),
    );

    const source = readFileSync(outputPath, "utf8");
    expect(source).toContain('"surfaceRef": "surface:1"');
    expect(source).not.toContain('"surfaceRef": "surface:2"');
    publisher.dispose();
  });

  it("publishes authoritative empty only after all fleet surfaces disappear", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1"]),
    );
    const lastGood = readFileSync(outputPath, "utf8");

    publisher.publish(
      publication("empty", [], ["surface:1", "surface:notes"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);

    publisher.publish(publication("empty", [], ["surface:notes"]));
    expect(readFileSync(outputPath, "utf8")).toContain(
      "cmuxlayer-fleet-state: empty",
    );
    publisher.dispose();
  });

  it("recognizes an unmarked legacy populated source as last-good", async () => {
    const outputPath = tempOutputPath();
    mkdirSync(join(outputPath, ".."), { recursive: true });
    const legacySource = renderFleetSidebar(
      snapshotWithSurfaces(["surface:1", "surface:2"]),
    ).replace(/^\/\/ cmuxlayer-fleet-state:[^\n]*\n/, "");
    writeFileSync(outputPath, legacySource, "utf8");
    const publisher = new FleetSidebarPublisher({ outputPath });

    publisher.publish(
      publication("discovering", [], ["surface:1", "surface:2"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(readFileSync(outputPath, "utf8")).toBe(legacySource);
    publisher.dispose();
  });

  it("does not rewrite byte-identical generated content", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({
      outputPath,
      minWriteIntervalMs: 500,
    });
    const snapshot = snapshotWithStatus("unchanged");

    publisher.publish(snapshot);
    const firstMtime = statSync(outputPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    publisher.publish(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(statSync(outputPath).mtimeMs).toBe(firstMtime);
    publisher.dispose();
  });

  it("coalesces rapid changes to the newest snapshot behind the 500ms gate", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({
      outputPath,
      minWriteIntervalMs: 500,
    });

    publisher.publish(snapshotWithStatus("first"));
    publisher.publish(snapshotWithStatus("superseded"));
    publisher.publish(snapshotWithStatus("newest"));

    expect(readFileSync(outputPath, "utf8")).toContain('"status": "first"');
    await new Promise((resolve) => setTimeout(resolve, 550));
    const published = readFileSync(outputPath, "utf8");
    expect(published).toContain('"status": "newest"');
    expect(published).not.toContain('"status": "superseded"');
    publisher.dispose();
  });

  it("keeps a pending additive snapshot when the next publication is unknown", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1"]),
    );
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );

    publisher.publish(publication("unknown", [], null));
    await new Promise((resolve) => setTimeout(resolve, 550));

    const published = readFileSync(outputPath, "utf8");
    expect(published).toContain('"surfaceRef": "surface:1"');
    expect(published).toContain('"surfaceRef": "surface:2"');
    publisher.dispose();
  });

  it("uses file mtime to rate-limit a second publisher instance", async () => {
    const outputPath = tempOutputPath();
    const first = new FleetSidebarPublisher({
      outputPath,
      minWriteIntervalMs: 500,
    });
    first.publish(snapshotWithStatus("owner-one"));
    first.dispose();

    const second = new FleetSidebarPublisher({
      outputPath,
      minWriteIntervalMs: 500,
    });
    second.publish(snapshotWithStatus("owner-two"));

    expect(readFileSync(outputPath, "utf8")).toContain(
      '"status": "owner-one"',
    );
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(readFileSync(outputPath, "utf8")).toContain(
      '"status": "owner-two"',
    );
    second.dispose();
  });

  it("does not flush a stale empty over a newer populated cross-process source", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({
      outputPath,
      minWriteIntervalMs: 500,
    });
    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1"]),
    );
    publisher.publish(publication("empty", [], []));

    await new Promise((resolve) => setTimeout(resolve, 100));
    const newerPopulatedSource = renderFleetSidebar(
      snapshotWithSurfaces(["surface:1", "surface:2"]),
      { state: "populated", observedLiveSurfaceCount: 2 },
    );
    writeFileSync(outputPath, newerPopulatedSource, "utf8");

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(readFileSync(outputPath, "utf8")).toBe(newerPopulatedSource);
    publisher.dispose();
  });

  it("does not flush a stale populated decrease over a newer topology", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({
      outputPath,
      minWriteIntervalMs: 500,
    });
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );
    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1"]),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const newerPopulatedSource = renderFleetSidebar(
      snapshotWithSurfaces(["surface:1", "surface:2", "surface:3"]),
      { state: "populated", observedLiveSurfaceCount: 3 },
    );
    writeFileSync(outputPath, newerPopulatedSource, "utf8");

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(readFileSync(outputPath, "utf8")).toBe(newerPopulatedSource);
    publisher.dispose();
  });

  it("cancels a pending coalesced write on dispose", async () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({
      outputPath,
      minWriteIntervalMs: 500,
    });
    publisher.publish(snapshotWithStatus("published"));
    publisher.publish(snapshotWithStatus("must-not-land"));

    publisher.dispose();
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(readFileSync(outputPath, "utf8")).toContain(
      '"status": "published"',
    );
  });
});

describe("fleet sidebar opt-in distribution", () => {
  it("pins the development runtime to the fleet-dev picker entry", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.dev).toContain(
      "CMUXLAYER_FLEET_SIDEBAR_OUTPUT_PATH=$HOME/.config/cmux/sidebars/fleet-dev.swift",
    );
    expect(packageJson.scripts?.dev).not.toMatch(/sidebars\/fleet\.swift/);
  });

  it("keeps the committed fallback asset identical to the empty generator output", () => {
    const assetPath = join(process.cwd(), "assets", "sidebars", "fleet.swift");

    expect(readFileSync(assetPath, "utf8")).toBe(
      renderFleetSidebar({ seatCount: 0, activeCount: 0, lanes: [] }),
    );
  });

  it("installs only fleet.swift under HOME without changing cmux settings or selection", () => {
    const home = mkdtempSync(join(tmpdir(), "cmuxlayer-fleet-install-"));
    tempDirs.push(home);
    const configDir = join(home, ".config", "cmux");
    mkdirSync(configDir, { recursive: true });
    const settingsPath = join(configDir, "settings.json");
    const settings = '{"selectedSidebar":"stock"}\n';
    writeFileSync(settingsPath, settings, "utf8");

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "install-fleet-sidebar.mjs")],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(configDir, "sidebars", "fleet.swift"), "utf8"),
    ).toBe(readFileSync(join(process.cwd(), "assets", "sidebars", "fleet.swift"), "utf8"));
    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    expect(existsSync(join(configDir, "cmux.json"))).toBe(false);
  });

  it("installs development previews only as fleet-dev.swift", () => {
    const home = mkdtempSync(join(tmpdir(), "cmuxlayer-fleet-dev-install-"));
    tempDirs.push(home);
    const configDir = join(home, ".config", "cmux");
    mkdirSync(configDir, { recursive: true });
    const settingsPath = join(configDir, "settings.json");
    const settings = '{"selectedSidebar":"fleet"}\n';
    writeFileSync(settingsPath, settings, "utf8");

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "install-fleet-sidebar-dev.mjs")],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(configDir, "sidebars", "fleet-dev.swift"), "utf8"),
    ).toBe(
      readFileSync(join(process.cwd(), "assets", "sidebars", "fleet.swift"), "utf8"),
    );
    expect(existsSync(join(configDir, "sidebars", "fleet.swift"))).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
  });
});
