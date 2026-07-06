import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  ingestCloseForensics,
  parseCmuxEvents,
  runCloseForensicsSweep,
  createDefaultCloseForensicsRunner,
  type CmuxEvent,
  type CloseForensicsCursorStore,
} from "../src/close-forensics.js";
import type {
  CloseForensicsEvent,
  CloseTelemetryEvent,
} from "../src/agent-types.js";
import { StateManager } from "../src/state-manager.js";

const FIXED_TS = "2026-07-07T00:00:00.000Z";
const now = () => FIXED_TS;

function surfaceClosed(over: Partial<CmuxEvent> = {}): CmuxEvent {
  return {
    name: "surface.closed",
    seq: 100,
    occurred_at: "2026-07-06T21:34:13.820Z",
    surface_id: "92AF15C5-EB43-4427-9820-5CE77AFC31AB",
    pane_id: "C4E5F762-99BC-4B29-A065-697FD59744DF",
    window_id: null,
    boot_id: "4E2A818D-54A0-48D3-954D-317057EC001C",
    workspace_id: "A4D082D6-EF72-4791-9DD8-AC083CCBAEC2",
    payload: {
      origin: "tab_close",
      surface_id: "92AF15C5-EB43-4427-9820-5CE77AFC31AB",
    },
    ...over,
  };
}

function windowKey(
  name: "window.keyed" | "window.unkeyed",
  occurred_at: string,
  seq: number,
): CmuxEvent {
  return {
    name,
    seq,
    occurred_at,
    surface_id: null,
    pane_id: null,
    window_id: "E0AE2C38-6EC1-46C8-9414-0095EDCC659D",
    boot_id: "4E2A818D-54A0-48D3-954D-317057EC001C",
    workspace_id: "A4D082D6-EF72-4791-9DD8-AC083CCBAEC2",
    payload: { origin: "appkit_key" },
  };
}

function mcpClose(
  over: Partial<CloseTelemetryEvent> = {},
): CloseTelemetryEvent {
  return {
    ts: "2026-07-06T21:34:13.000Z",
    event_type: "close",
    event: "close_surface",
    target: "surface:42",
    caller: "CMUX_TAB_ID=abc",
    force: false,
    reason: null,
    refused: false,
    ...over,
  };
}

describe("ingestCloseForensics — attribution", () => {
  it("attributes to the MCP close when one matches the mapped surface within Δt", () => {
    const map = new Map([
      ["92AF15C5-EB43-4427-9820-5CE77AFC31AB", "surface:42"],
    ]);
    const { events } = ingestCloseForensics({
      cmuxEvents: [surfaceClosed()],
      mcpCloses: [mcpClose({ ts: "2026-07-06T21:34:14.000Z" })], // ~0.2s after close
      surfaceRefByCmuxId: map,
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events).toHaveLength(1);
    expect(events[0].attribution).toBe(
      "mcp:close_surface caller=CMUX_TAB_ID=abc",
    );
    expect(events[0].origin).toBe("tab_close");
    expect(events[0].cmux_surface_id).toBe(
      "92AF15C5-EB43-4427-9820-5CE77AFC31AB",
    );
    expect(events[0].ts).toBe(FIXED_TS);
  });

  it("does NOT attribute an MCP close that is outside Δt", () => {
    const map = new Map([
      ["92AF15C5-EB43-4427-9820-5CE77AFC31AB", "surface:42"],
    ]);
    const { events } = ingestCloseForensics({
      cmuxEvents: [surfaceClosed()],
      // 10 minutes after the close — well outside a 30s Δt.
      mcpCloses: [mcpClose({ ts: "2026-07-06T21:44:13.000Z" })],
      surfaceRefByCmuxId: map,
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events[0].attribution).toBe("app-level:no-mcp-close");
  });

  it("reports app-level when NO MCP close matches (the smoking gun)", () => {
    const { events } = ingestCloseForensics({
      cmuxEvents: [surfaceClosed()],
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events[0].attribution).toBe("app-level:no-mcp-close");
  });

  it("matches an MCP close whose target is the raw cmux UUID (no ref map)", () => {
    const { events } = ingestCloseForensics({
      cmuxEvents: [surfaceClosed()],
      mcpCloses: [
        mcpClose({
          target: "92AF15C5-EB43-4427-9820-5CE77AFC31AB",
          event: "kill",
          caller: "mcp:stop_agent",
        }),
      ],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events[0].attribution).toBe("mcp:kill caller=mcp:stop_agent");
  });
});

describe("ingestCloseForensics — client_context (rc/screen-share signal)", () => {
  it("flags a window key cycle within Δt and records the nearest key event", () => {
    const close = surfaceClosed({
      occurred_at: "2026-07-06T21:34:13.820Z",
      seq: 200,
    });
    const { events } = ingestCloseForensics({
      cmuxEvents: [
        windowKey("window.unkeyed", "2026-07-06T21:33:56.240Z", 198), // ~17s before
        windowKey("window.keyed", "2026-07-06T21:34:01.256Z", 199), // ~12s before (nearer)
        close,
      ],
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events[0].client_context.window_key_cycle_near_close).toBe(true);
    // Nearest at-or-before the close is the "keyed" event.
    expect(events[0].client_context.last_window_key_event).toBe("keyed");
  });

  it("does not flag a key cycle when window events are outside Δt", () => {
    const close = surfaceClosed({
      occurred_at: "2026-07-06T21:34:13.820Z",
      seq: 200,
    });
    const { events } = ingestCloseForensics({
      cmuxEvents: [
        windowKey("window.unkeyed", "2026-07-06T21:20:00.000Z", 198), // >14min before
        close,
      ],
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events[0].client_context.window_key_cycle_near_close).toBe(false);
    expect(events[0].client_context.last_window_key_event).toBeNull();
  });

  it("flags boot_id_changed_since_prev when consecutive closes have different boot_ids", () => {
    const first = surfaceClosed({ seq: 10, boot_id: "BOOT-AAA" });
    const second = surfaceClosed({ seq: 20, boot_id: "BOOT-BBB" });
    const { events } = ingestCloseForensics({
      cmuxEvents: [first, second],
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events).toHaveLength(2);
    expect(events[0].client_context.boot_id_changed_since_prev).toBe(false); // no prior close
    expect(events[1].client_context.boot_id_changed_since_prev).toBe(true); // boot changed
  });

  it("does not flag boot change when consecutive closes share a boot_id", () => {
    const first = surfaceClosed({ seq: 10, boot_id: "BOOT-AAA" });
    const second = surfaceClosed({ seq: 20, boot_id: "BOOT-AAA" });
    const { events } = ingestCloseForensics({
      cmuxEvents: [first, second],
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 0,
      now,
    });
    expect(events[1].client_context.boot_id_changed_since_prev).toBe(false);
  });
});

describe("ingestCloseForensics — cursor", () => {
  it("only emits closes with seq > lastSeq and advances the cursor", () => {
    const events = [
      surfaceClosed({ seq: 5 }),
      surfaceClosed({ seq: 10 }),
      surfaceClosed({ seq: 15 }),
    ];
    const first = ingestCloseForensics({
      cmuxEvents: events,
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 8,
      now,
    });
    // Only seq 10 and 15 are newer than 8.
    expect(first.events).toHaveLength(2);
    expect(first.nextSeq).toBe(15);

    // Re-run with the advanced cursor → nothing new.
    const second = ingestCloseForensics({
      cmuxEvents: events,
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: first.nextSeq,
      now,
    });
    expect(second.events).toHaveLength(0);
    expect(second.nextSeq).toBe(15);
  });

  it("seeds boot continuity from below-cursor closes so the first new close compares correctly", () => {
    const older = surfaceClosed({ seq: 5, boot_id: "BOOT-AAA" });
    const newer = surfaceClosed({ seq: 10, boot_id: "BOOT-BBB" });
    const { events } = ingestCloseForensics({
      cmuxEvents: [older, newer],
      mcpCloses: [],
      surfaceRefByCmuxId: new Map(),
      deltaMs: 30_000,
      lastSeq: 5, // older is below cursor, only newer emits
      now,
    });
    expect(events).toHaveLength(1);
    expect(events[0].boot_id).toBe("BOOT-BBB");
    // Compares against the below-cursor older close's boot_id → changed.
    expect(events[0].client_context.boot_id_changed_since_prev).toBe(true);
  });
});

describe("parseCmuxEvents / ingest — malformed & missing tolerance", () => {
  it("skips malformed lines and still parses the good ones", () => {
    const text = [
      '{"name":"surface.closed","seq":1,"occurred_at":"2026-07-06T21:00:00.000Z","surface_id":"S1","pane_id":null,"window_id":null,"boot_id":"B","workspace_id":"W","payload":{"origin":"tab_close"}}',
      "not json at all {",
      "",
      '{"missing":"name and seq"}',
      '{"name":"surface.closed","seq":2,"occurred_at":"2026-07-06T21:01:00.000Z","surface_id":"S2","pane_id":null,"window_id":null,"boot_id":"B","workspace_id":"W","payload":{"origin":"workspace_teardown"}}',
    ].join("\n");
    const parsed = parseCmuxEvents(text);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.name)).toEqual([
      "surface.closed",
      "surface.closed",
    ]);
    expect(parsed[1].payload?.origin).toBe("workspace_teardown");
  });

  it("runCloseForensicsSweep never throws when the events file is missing", () => {
    const emitted: CloseForensicsEvent[] = [];
    const cursor: CloseForensicsCursorStore = {
      read: () => 0,
      write: () => {},
    };
    const result = runCloseForensicsSweep({
      readCmuxEventsText: () => null, // missing file
      readMcpCloses: () => [],
      surfaceRefByCmuxId: () => new Map(),
      appendForensics: (e) => emitted.push(e),
      cursor,
      now,
      deltaMs: 30_000,
    });
    expect(result.emitted).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it("runCloseForensicsSweep never throws when a dependency throws", () => {
    const result = runCloseForensicsSweep({
      readCmuxEventsText: () => {
        throw new Error("disk exploded");
      },
      readMcpCloses: () => {
        throw new Error("nope");
      },
      surfaceRefByCmuxId: () => new Map(),
      appendForensics: () => {
        throw new Error("append fail");
      },
      cursor: {
        read: () => {
          throw new Error("cursor read fail");
        },
        write: () => {
          throw new Error("cursor write fail");
        },
      },
      now,
      deltaMs: 30_000,
    });
    expect(result.emitted).toBe(0);
  });
});

describe("runCloseForensicsSweep — persisted cursor end-to-end", () => {
  it("appends new forensics, advances the cursor, and does not double-emit on re-run", () => {
    const appended: CloseForensicsEvent[] = [];
    let cursorSeq = 0;
    const cursor: CloseForensicsCursorStore = {
      read: () => cursorSeq,
      write: (seq) => {
        cursorSeq = seq;
      },
    };
    const text = [
      JSON.stringify(surfaceClosed({ seq: 1, surface_id: "S1" })),
      JSON.stringify(surfaceClosed({ seq: 2, surface_id: "S2" })),
    ].join("\n");
    const deps = {
      readCmuxEventsText: () => text,
      readMcpCloses: () => [] as CloseTelemetryEvent[],
      surfaceRefByCmuxId: () => new Map<string, string>(),
      appendForensics: (e: CloseForensicsEvent) => appended.push(e),
      cursor,
      now,
      deltaMs: 30_000,
    };
    const first = runCloseForensicsSweep(deps);
    expect(first.emitted).toBe(2);
    expect(appended).toHaveLength(2);
    expect(cursorSeq).toBe(2);

    const second = runCloseForensicsSweep(deps);
    expect(second.emitted).toBe(0);
    expect(appended).toHaveLength(2); // unchanged — no double emit
  });
});

describe("createDefaultCloseForensicsRunner — real fs wiring (temp dirs)", () => {
  let stateDir: string;
  let eventsPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cf-state-"));
    eventsPath = join(
      mkdtempSync(join(tmpdir(), "cf-events-")),
      "events.jsonl",
    );
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("ingests from a real events file, writes to the event log, and persists the cursor", () => {
    writeFileSync(
      eventsPath,
      [
        JSON.stringify(surfaceClosed({ seq: 1, surface_id: "S1" })),
        JSON.stringify(surfaceClosed({ seq: 2, surface_id: "S2" })),
      ].join("\n"),
      "utf-8",
    );
    const stateMgr = new StateManager(stateDir);
    const runner = createDefaultCloseForensicsRunner({
      stateMgr,
      eventsPath,
      now,
    });

    const first = runner();
    expect(first.emitted).toBe(2);

    const forensics = stateMgr
      .getEventLog()
      .readEntries()
      .filter(
        (e) => (e as { event_type?: string }).event_type === "close_forensics",
      );
    expect(forensics).toHaveLength(2);

    // Re-run: cursor persisted → no double emit.
    const second = runner();
    expect(second.emitted).toBe(0);
    const forensicsAfter = stateMgr
      .getEventLog()
      .readEntries()
      .filter(
        (e) => (e as { event_type?: string }).event_type === "close_forensics",
      );
    expect(forensicsAfter).toHaveLength(2);
  });
});

describe("close forensics — does not disturb the operator outbox", () => {
  it("leaves ~/.golems-zikaron/outbox.md mtime unchanged across a full run", () => {
    // Guard: forensics must never write to the operator outbox. We assert the
    // real outbox's mtime is untouched (creating an empty temp one only if
    // absent so the assertion is meaningful without mutating real content).
    const outboxDir = join(homedir(), ".golems-zikaron");
    const outboxPath = join(outboxDir, "outbox.md");
    let createdForTest = false;
    let before: number;
    try {
      before = statSync(outboxPath).mtimeMs;
    } catch {
      mkdirSync(outboxDir, { recursive: true });
      writeFileSync(outboxPath, "", "utf-8");
      createdForTest = true;
      before = statSync(outboxPath).mtimeMs;
    }

    const stateDir = mkdtempSync(join(tmpdir(), "cf-outbox-"));
    const eventsPath = join(
      mkdtempSync(join(tmpdir(), "cf-outbox-ev-")),
      "events.jsonl",
    );
    try {
      writeFileSync(
        eventsPath,
        JSON.stringify(surfaceClosed({ seq: 1 })) + "\n",
        "utf-8",
      );
      const stateMgr = new StateManager(stateDir);
      const runner = createDefaultCloseForensicsRunner({
        stateMgr,
        eventsPath,
        now,
      });
      runner();

      const after = statSync(outboxPath).mtimeMs;
      expect(after).toBe(before);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      if (createdForTest) rmSync(outboxPath, { force: true });
    }
  });
});
