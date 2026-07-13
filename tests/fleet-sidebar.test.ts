import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentHealthIssueCode,
  AgentHealthIssueSeverity,
} from "../src/agent-health.js";
import {
  buildFleetSidebarSnapshot,
  defaultFleetSidebarPath,
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
            "seat_identity_mismatch",
          ],
          healthReasons: [
            "agent was auto-discovered, not created through managed spawn_agent",
            "agent inbox monitor heartbeat is absent or stale",
            "spawned agent seat identity does not match the registry and requires operator repair",
          ],
          healthIssueSeverities: {
            auto_discovered_agent: "info",
            inbox_monitor_not_alive: "degraded",
            seat_identity_mismatch: "blocking",
          },
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      healthVisible: true,
      health:
        "spawned agent seat identity does not match the registry and requires operator repair",
    });
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
  it("renders exact counts and click-to-focus actions for the final live rows", () => {
    const snapshot = buildFleetSidebarSnapshot(
      [candidate({ surfaceRef: "surface:7" })],
      { liveSurfaceRefs: new Set(["surface:7"]) },
    );

    const source = renderFleetSidebar(snapshot);

    expect(source).toContain('fleetLane("cmuxlayer", 1, 1, false, [');
    expect(source).toContain(
      'cmux("surface.focus", surface_id: seat.surfaceRef)',
    );
    expect(source).toContain('"surfaceRef": "surface:7"');
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
    expect(source).toContain('Text("\\(liveCount) idle seats collapsed")');
  });

  it("preserves and escapes full status and health text without truncation modifiers", () => {
    const status = 'Review "quoted" \\ path\nnext line';
    const health = "בריאות מלאה — reason must wrap";
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate({
          taskSummary: status,
          healthStatus: "unhealthy",
          healthIssueCodes: ["seat_identity_mismatch"],
          healthReasons: [health],
          healthIssueSeverities: { seat_identity_mismatch: "blocking" },
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:1"]) },
    );

    const source = renderFleetSidebar(snapshot);

    expect(source).toContain(`"status": ${JSON.stringify(status)}`);
    expect(source).toContain(`"health": ${JSON.stringify(health)}`);
    expect(source).not.toContain(".fixedSize");
    expect(source).not.toContain(".lineLimit");
    expect(source).not.toContain(".truncationMode");
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

  it("renders an explicit, valid empty fleet state", () => {
    const source = renderFleetSidebar({
      seatCount: 0,
      activeCount: 0,
      lanes: [],
    });

    expect(source).toContain('Text("No live fleet seats")');
    expect(source).toContain('Text("0 live seats · 0 active")');
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

  it("uses the canonical home-relative output path", () => {
    expect(defaultFleetSidebarPath("/tmp/example-home")).toBe(
      "/tmp/example-home/.config/cmux/sidebars/fleet.swift",
    );
  });

  it("creates the target atomically and leaves no temporary file", () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });

    publisher.publish(snapshotWithStatus("first"));

    expect(readFileSync(outputPath, "utf8")).toContain('"status": "first"');
    expect(readdirSync(join(outputPath, ".."))).toEqual(["fleet.swift"]);
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
});
