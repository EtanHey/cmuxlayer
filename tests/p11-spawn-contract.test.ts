/**
 * P11 / U10 — the PRODUCER half of the coordination contract.
 *
 * The consumer half (assessHarvestability) shipped long ago, but nothing ever
 * issued it a contract: spawn_agent never set goal_file, so every spawned
 * worker read `terminal_contract_missing` forever, and leads invented report
 * paths in prose that a regex heuristic then tried to guess back out. These
 * tests pin the fix: the engine authors the contract ONCE, returns it in the
 * receipt, persists it, and tells the worker the same two strings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { runWithCallerContext } from "../src/caller-context.js";
import {
  BOOT_INJECTION_CHUNK_THRESHOLD,
  coordinationFooter,
  coordinationFooterBytes,
  issueCoordinationContract,
} from "../src/coordination-paths.js";

const STATE_DIR = join(tmpdir(), "cmux-agents-test-p11-spawn");

interface TestSurface {
  id?: string;
  ref: string;
  title: string;
  text: string;
}

function makeExec(
  screenText = "What can I help you with?\n>",
  surfaceTitle = "agent-pane",
  mutableScreen?: { text: string },
  additionalSurfaces: TestSurface[] = [],
  primarySurfaceUuid?: string,
): ExecFn {
  let promptPending = false;
  let pastePending = false;
  let currentScreenText = screenText;
  const surfaces: TestSurface[] = [
    {
      id: primarySurfaceUuid,
      ref: "surface:new",
      title: surfaceTitle,
      text: screenText,
    },
    ...additionalSurfaces,
  ];
  const setScreenText = (text: string) => {
    currentScreenText = text;
    if (mutableScreen) mutableScreen.text = text;
  };
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Main",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: surfaces.length,
              surface_refs: surfaces.map(({ ref }) => ref),
              ...(surfaces.every(({ id }) => id)
                ? { surface_ids: surfaces.map(({ id }) => id!) }
                : {}),
              selected_surface_ref: "surface:new",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: surfaces.map((surface, index) =>
            ({
              id: surface.id,
              ref: surface.ref,
              title: surface.title,
              type: "terminal",
              index,
              selected: index === 0,
            }),
          ),
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      const surface =
        surfaces.find(({ ref }) => args.includes(ref)) ?? surfaces[0]!;
      return {
        stdout: JSON.stringify({
          surface: surface.ref,
          text:
            surface.ref === "surface:new"
              ? (mutableScreen?.text ?? currentScreenText)
              : surface.text,
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    if (args.includes("send-key") && args.includes("return")) {
      if (promptPending) {
        setScreenText("Claude Code\n✻ Working\n");
        promptPending = false;
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("set-buffer")) {
      pastePending = String(args.at(-1) ?? "").trim().length > 0;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("paste-buffer")) {
      if (pastePending) promptPending = true;
      pastePending = false;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
      const text = String(args.at(-1) ?? "");
      if (
        text.trim() &&
        (text.includes("cmuxlayer mailbox contract") ||
          !/[A-Za-z0-9_.-]+(?:Claude|Codex|Cursor|Gemini|Kiro)\b/.test(text))
      ) {
        promptPending = true;
      }
    }
    return {
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:new",
        ...(primarySurfaceUuid ? { surface_id: primarySurfaceUuid } : {}),
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

/** Everything typed or pasted at the pane, however it was routed. */
function sentText(exec: ExecFn): string {
  return (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(([, args]: [string, string[]]) => (args ?? []).join(" "))
    .join("\n");
}

describe("P11 spawn_agent issues the coordination contract", () => {
  let inboxDir: string;
  let exec: ExecFn;
  let server: any;

  beforeEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true });
    inboxDir = mkdtempSync(join(tmpdir(), "p11-inbox-"));
    exec = makeExec();
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
      }),
    );
  });

  afterEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  });

  async function spawn(extra: Record<string, unknown> = {}) {
    const tool = server._registeredTools["spawn_agent"];
    const result = await runWithCallerContext({ workspaceId: "workspace:1" }, () =>
      tool.handler(
        {
          repo: "brainlayer",
          model: "sonnet",
          cli: "claude",
          role: "worker",
          prompt: "task",
          ...extra,
        },
        {} as any,
      ),
    );
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }

  it("returns report_path and done_marker in the LEAN receipt", async () => {
    const parsed = await spawn();
    expect(parsed.ok).toBe(true);
    const expected = issueCoordinationContract(parsed.agent_id as string, {
      baseDir: inboxDir,
    });
    expect(parsed.report_path).toBe(expected.report_path);
    expect(parsed.done_marker).toBe(expected.done_marker);
  });

  it("persists the contract on the record, so the consumer reads what was issued", async () => {
    const parsed = await spawn();
    const getState = server._registeredTools["get_agent_state"];
    const state = await getState.handler({ agent_id: parsed.agent_id }, {} as any);
    const detail = state.structuredContent ?? JSON.parse(state.content[0].text);
    expect(detail.report_path).toBe(parsed.report_path);
    expect(detail.done_marker).toBe(parsed.done_marker);
  });

  it("does NOT yet inject the footer into the boot prompt (measured budget collision)", async () => {
    // The mailbox contract alone is ~479 chars for a real agent id and
    // SEND_INPUT_CHUNK_THRESHOLD is 500, so injecting the report contract moves
    // EVERY spawn's boot delivery onto the chunked paste path. That is not
    // additive, so it is deliberately not wired -- pinned here so the day it is
    // wired is a deliberate, reviewed change rather than a silent one.
    const parsed = await spawn();
    expect(sentText(exec)).not.toContain(parsed.report_path);
  });

  it("keeps the boot injection inside the chunk-threshold budget", async () => {
    await spawn();
    const injections = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([, args]: [string, string[]]) => String((args ?? []).at(-1) ?? ""))
      .filter((text) => text.includes("cmuxlayer mailbox contract"));
    expect(injections.length).toBeGreaterThan(0);
    for (const text of injections) {
      expect(text.length).toBeLessThan(BOOT_INJECTION_CHUNK_THRESHOLD);
    }
  });

  it("declares the footer's own byte cost (Constraint 1, #424/#425)", async () => {
    const parsed = await spawn();
    expect(parsed.coordination_footer_bytes).toBe(
      coordinationFooterBytes({
        report_path: parsed.report_path,
        done_marker: parsed.done_marker,
      }),
    );
    // One line, so the injected boot prompt stays single-line and typed.
    expect(
      coordinationFooter({
        report_path: parsed.report_path,
        done_marker: parsed.done_marker,
      }),
    ).not.toMatch(/[\r\n]/);
    expect(parsed.coordination_footer_bytes).toBeLessThan(240);
  });

  it("REGISTRY-OPTIONAL PARITY (#453): the contract does not depend on the launcher", async () => {
    // The contract is derived from agent_id and applied ABOVE launchMode, so a
    // raw-CLI spawn cannot get a different (or missing) contract. Asserted on
    // real receipts from two independent servers, not on the derivation fn.
    const registered = await spawn();

    const rawInboxDir = mkdtempSync(join(tmpdir(), "p11-inbox-raw-"));
    const rawStateDir = mkdtempSync(join(tmpdir(), "p11-state-raw-"));
    const previousRegistry = process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
    process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = join(
      rawInboxDir,
      "no-such-launcher-registry.zsh",
    );
    try {
      const rawExec = makeExec();
      const rawServer: any = createServer(
        withTestSurfaceObserver({
          exec: rawExec,
          stateDir: rawStateDir,
          disableSpawnPreflight: true,
          inboxBaseDir: rawInboxDir,
        }),
      );
      const rawResult = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        () =>
          rawServer._registeredTools["spawn_agent"].handler(
            {
              repo: "brainlayer",
              cli: "claude",
              role: "worker",
              prompt: "task",
            },
            {} as any,
          ),
      );
      const raw =
        rawResult.structuredContent ?? JSON.parse(rawResult.content[0].text);

      expect(raw.ok).toBe(true);
      expect(raw.report_path).toBe(
        issueCoordinationContract(raw.agent_id as string, {
          baseDir: rawInboxDir,
        }).report_path,
      );
      expect(raw.done_marker).toBeTruthy();
      // Assert both are actually defined -- the earlier ternary compared `raw`
      // to itself when `registered` was undefined, which proved nothing.
      expect(typeof registered.coordination_footer_bytes).toBe("number");
      expect(raw.coordination_footer_bytes).toBe(
        coordinationFooterBytes({
          report_path: raw.report_path,
          done_marker: raw.done_marker,
        }),
      );
      // Provenance travels on both doors too.
      for (const receipt of [registered, raw]) {
        expect(receipt.coordination_footer_delivered).toBe(false);
      }
      // Same contract SHAPE on both doors: issued, absolute, marker present.
      for (const receipt of [registered, raw]) {
        expect(receipt.report_path).toMatch(/^\/.+\/report\.md$/);
        expect(receipt.done_marker).toMatch(/^DONE_[A-Z0-9_:-]+$/);
      }
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
      } else {
        process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = previousRegistry;
      }
      rmSync(rawInboxDir, { recursive: true, force: true });
      rmSync(rawStateDir, { recursive: true, force: true });
    }
  });

  it("FINDING 3: never reports footer bytes without reporting they were not sent", async () => {
    const parsed = await spawn();
    // The v0.4.41 `paused` hazard: an authoritative number with no provenance.
    expect(parsed.coordination_footer_bytes).toBeGreaterThan(0);
    expect(parsed.coordination_footer_delivered).toBe(false);
    expect(parsed.coordination_footer_note).toMatch(/not_wired/);
    // A lead reading this must learn it has to relay the contract itself.
    expect(parsed.coordination_footer_note).toMatch(/LEAD must relay/i);
  });

  it("FINDING 2: a relative report_path is rejected BEFORE anything launches", async () => {
    const tool = server._registeredTools["spawn_agent"];
    const before = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    let rejected = false;
    let message = "";
    try {
      const result = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        () =>
          tool.handler(
            {
              repo: "brainlayer",
              cli: "claude",
              role: "worker",
              prompt: "task",
              report_path: "reports/worker.md",
            },
            {} as any,
          ),
      );
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);
      rejected = parsed.ok === false;
      message = String(parsed.error ?? "");
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    expect(rejected).toBe(true);
    expect(message).toMatch(/absolute/i);
    // The real defect: no pane, no worktree, no launch on a validation error.
    expect(
      (exec as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(before);
  });

  it("echoes and persists an explicit absolute report_path override", async () => {
    const override = join(inboxDir, "collab", "worker-report.md");
    const parsed = await spawn({ report_path: override });
    expect(parsed.report_path).toBe(override);
    const getState = server._registeredTools["get_agent_state"];
    const state = await getState.handler({ agent_id: parsed.agent_id }, {} as any);
    const detail = state.structuredContent ?? JSON.parse(state.content[0].text);
    expect(detail.report_path).toBe(override);
  });
});
