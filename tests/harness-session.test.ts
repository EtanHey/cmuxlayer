import { afterAll, describe, expect, it } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHarnessSession,
  modelContextWindow,
  resolveSessionPath,
  readHarnessSessionFromFile,
  findLatestHarnessSessionIdentity,
  findHarnessSessionPath,
  loadHarnessSession,
  loadHarnessSessionWithMeta,
  applyHarnessState,
  harnessJsonlEnabled,
  readHarnessSessionTextWindow,
} from "../src/harness-session.js";

const FIX = join(__dirname, "fixtures", "harness");
const read = (name: string) => readFileSync(join(FIX, name), "utf8");

function codexContextJsonl(
  model: string,
  tokensUsed: number,
  contextWindow: number,
): string {
  return [
    JSON.stringify({
      type: "turn_context",
      payload: { type: "turn_context", model },
    }),
    JSON.stringify({
      type: "token_count",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: tokensUsed },
          model_context_window: contextWindow,
        },
      },
    }),
  ].join("\n");
}

describe("harnessJsonlEnabled (default-ON, opt-out with =0)", () => {
  const prev = process.env.CMUXLAYER_HARNESS_JSONL;
  afterAll(() => {
    if (prev === undefined) delete process.env.CMUXLAYER_HARNESS_JSONL;
    else process.env.CMUXLAYER_HARNESS_JSONL = prev;
  });
  it("defaults ON when unset", () => {
    delete process.env.CMUXLAYER_HARNESS_JSONL;
    expect(harnessJsonlEnabled()).toBe(true);
  });
  it("stays ON for =1", () => {
    process.env.CMUXLAYER_HARNESS_JSONL = "1";
    expect(harnessJsonlEnabled()).toBe(true);
  });
  it("opts OUT only for =0", () => {
    process.env.CMUXLAYER_HARNESS_JSONL = "0";
    expect(harnessJsonlEnabled()).toBe(false);
  });
});

describe("parseHarnessSession", () => {
  it("Claude: tokens from last usage tail, window from model table (NOT in JSONL)", () => {
    const s = parseHarnessSession("claude", read("claude.jsonl"));
    expect(s.harness).toBe("claude");
    expect(s.model).toBe("claude-opus-4-8");
    // 40000 input + 30000 cache_read + 10000 cache_creation + 2000 output
    expect(s.tokens_used).toBe(82000);
    expect(s.context_window).toBe(1_000_000); // opus-4-8 = 1M (from table)
    expect(s.context_pct).toBe(8); // 82000/1_000_000
    expect(s.last_text).toBe("latest reply here");
    expect(s.last_tool).toBe("Read");
  });

  it("Codex: window + tokens BOTH from JSONL — proves the 1M bug is dead (258400 ≠ 1M)", () => {
    const s = parseHarnessSession("codex", read("codex.jsonl"));
    expect(s.harness).toBe("codex");
    expect(s.model).toBe("gpt-5.5");
    expect(s.tokens_used).toBe(108569); // last token_count → last_token_usage.total_tokens
    expect(s.context_window).toBe(258400); // payload.info.model_context_window — in-JSONL
    expect(s.context_window).not.toBe(1_000_000);
    expect(s.context_pct).toBe(42); // 108569/258400
    expect(s.last_text).toBe("codex latest message");
    expect(s.last_tool).toBe("exec_command");
  });

  it("Codex: gpt-5.6 uses the verified 400K app-tier floor over stale JSONL", () => {
    const s = parseHarnessSession(
      "codex",
      codexContextJsonl("gpt-5.6-sol", 105_000, 353_400),
    );

    expect(s.context_window).toBe(400_000);
    expect(s.context_pct).toBe(26);
  });

  it("Codex: unknown models keep their JSONL window as the only signal", () => {
    const s = parseHarnessSession(
      "codex",
      codexContextJsonl("future-unknown-model", 70_680, 353_400),
    );

    expect(s.context_window).toBe(353_400);
    expect(s.context_pct).toBe(20);
  });

  it("Codex: a larger JSONL window stays larger than the verified floor", () => {
    const s = parseHarnessSession(
      "codex",
      codexContextJsonl("gpt-5.6-sol", 210_000, 2_100_000),
    );

    expect(s.context_window).toBe(2_100_000);
    expect(s.context_pct).toBe(10);
  });

  it("Cursor: NO tokens/window in JSONL — text/tool only, context left to the TUI strip", () => {
    const s = parseHarnessSession("cursor", read("cursor.jsonl"));
    expect(s.harness).toBe("cursor");
    expect(s.tokens_used).toBeNull();
    expect(s.context_window).toBeNull();
    expect(s.context_pct).toBeNull();
    expect(s.last_text).toBe("cursor latest message");
    expect(s.last_tool).toBe("Read");
  });

  it("ignores blank lines and unparseable lines without throwing", () => {
    const dirty = "\n{not json}\n" + read("codex.jsonl") + "\n\n";
    const s = parseHarnessSession("codex", dirty);
    expect(s.context_window).toBe(258400);
    expect(s.tokens_used).toBe(108569);
  });

  it("empty transcript → all nulls, done=false", () => {
    const s = parseHarnessSession("claude", "");
    expect(s.tokens_used).toBeNull();
    expect(s.context_window).toBeNull();
    expect(s.context_pct).toBeNull();
    expect(s.done).toBe(false);
  });

  it("Claude: settled end_turn with trailing harness metadata is done", () => {
    const s = parseHarnessSession(
      "claude",
      [
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-8",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "TASK_DONE" }],
          },
        }),
        JSON.stringify({ type: "system", content: "harness metadata" }),
        JSON.stringify({ type: "last-prompt", prompt: "previous prompt" }),
        JSON.stringify({ type: "mode", mode: "default" }),
        JSON.stringify({ type: "permission-mode", mode: "acceptEdits" }),
        JSON.stringify({ type: "pr-link", url: "https://example.invalid/pr" }),
      ].join("\n"),
    );

    expect(s.done).toBe(true);
  });

  it("Claude: unanswered terminal tool_use is still in flight", () => {
    const s = parseHarnessSession(
      "claude",
      [
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-8",
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "I will inspect the file." },
              { type: "tool_use", id: "toolu_018xNv2zPGrCXaudR29Wsdef", name: "Read" },
            ],
          },
        }),
        JSON.stringify({ type: "queue-operation", op: "append" }),
        JSON.stringify({ type: "last-prompt", prompt: "continue" }),
        JSON.stringify({ type: "agent-setting", name: "model" }),
        JSON.stringify({ type: "mode", mode: "default" }),
        JSON.stringify({ type: "permission-mode", mode: "acceptEdits" }),
      ].join("\n"),
    );

    expect(s.done).toBe(false);
  });

  it("Claude: terminal tool_use is done once a later user tool_result answers it", () => {
    const toolUseId = "toolu_019cdJd1eHLJHcwLgEHTUU2L";
    const s = parseHarnessSession(
      "claude",
      [
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-8",
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "Running the check." },
              { type: "tool_use", id: toolUseId, name: "Bash" },
            ],
          },
        }),
        JSON.stringify({ type: "attachment", name: "ctx" }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: toolUseId, content: "ok" },
            ],
          },
        }),
        JSON.stringify({ type: "attachment", name: "more ctx" }),
        JSON.stringify({ type: "last-prompt", prompt: "continue" }),
        JSON.stringify({ type: "custom-title", title: "private-tmp" }),
        JSON.stringify({ type: "agent-name", name: "cmuxlayerClaude" }),
        JSON.stringify({ type: "mode", mode: "default" }),
        JSON.stringify({ type: "permission-mode", mode: "acceptEdits" }),
        JSON.stringify({ type: "bridge-session", id: "bridge" }),
      ].join("\n"),
    );

    expect(s.done).toBe(true);
  });

  it("Codex: task_complete marks done", () => {
    const s = parseHarnessSession("codex", read("codex.jsonl"));
    expect(s.done).toBe(true);
  });

  it("Codex: later task_started resets stale task_complete done", () => {
    const s = parseHarnessSession(
      "codex",
      [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-2" },
        }),
      ].join("\n"),
    );

    expect(s.done).toBe(false);
  });
});

describe("modelContextWindow (Claude denominator + no-JSONL fallback)", () => {
  it("maps current-gen 1M Claude models", () => {
    expect(modelContextWindow("claude-opus-4-8")).toBe(1_000_000);
    expect(modelContextWindow("claude-opus-4-6")).toBe(1_000_000);
    expect(modelContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
  });

  it("maps 200K-tier Claude models", () => {
    expect(modelContextWindow("claude-haiku-4-5")).toBe(200_000);
    expect(modelContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(modelContextWindow("claude-opus-4-1")).toBe(200_000);
  });

  it("GPT-5.6 family = 400K verified app-tier window", () => {
    expect(modelContextWindow("gpt-5.6")).toBe(400_000);
    expect(modelContextWindow("gpt-5.6-sol")).toBe(400_000);
  });

  it("plain GPT-5/Codex family stays at 400K", () => {
    expect(modelContextWindow("gpt-5")).toBe(400_000);
    expect(modelContextWindow("gpt-5.5")).toBe(400_000);
    expect(modelContextWindow("gpt-5-codex")).toBe(400_000);
    expect(modelContextWindow("gpt-5.1")).toBe(400_000);
  });

  it("GPT-4 family = 128K; Gemini = 1,048,576", () => {
    expect(modelContextWindow("gpt-4o")).toBe(128_000);
    expect(modelContextWindow("gpt-4-turbo")).toBe(128_000);
    expect(modelContextWindow("gemini-2.5-pro")).toBe(1_048_576);
    expect(modelContextWindow("gemini-3-pro")).toBe(1_048_576);
  });

  it("unknown → null (never a wrong 1M)", () => {
    expect(modelContextWindow(null)).toBeNull();
    expect(modelContextWindow("mystery-model")).toBeNull();
  });
});

describe("resolveSessionPath (cwd + sessionId → JSONL path)", () => {
  const home = "/home/u";
  it("Claude: ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl (leading dash)", () => {
    const p = resolveSessionPath(
      "claude",
      "/Users/e/Gits/cmuxlayer",
      "abc-123",
      {
        home,
      },
    );
    expect(p).toBe(
      "/home/u/.claude/projects/-Users-e-Gits-cmuxlayer/abc-123.jsonl",
    );
  });

  it("Cursor: ~/.cursor/projects/<enc-cwd-no-leading-dash>/agent-transcripts/<id>/<id>.jsonl", () => {
    const p = resolveSessionPath("cursor", "/Users/e/Gits/golems", "id9", {
      home,
    });
    expect(p).toBe(
      "/home/u/.cursor/projects/Users-e-Gits-golems/agent-transcripts/id9/id9.jsonl",
    );
  });
});

describe("readHarnessSessionTextWindow", () => {
  it("reads only the tail window of a large harness transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-window-"));
    const path = join(dir, "session.jsonl");
    try {
      const oldLine = JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-4-8", usage: { input_tokens: 1 } },
      });
      const latestLine = JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 123, output_tokens: 4 },
          content: [{ type: "text", text: "latest tail text" }],
        },
      });
      writeFileSync(path, `${oldLine}\n`.repeat(2000) + `${latestLine}\n`, "utf8");

      const text = readHarnessSessionTextWindow(path, { maxBytes: 2048 });

      expect(text).not.toBeNull();
      expect(Buffer.byteLength(text ?? "")).toBeLessThanOrEqual(2048);
      expect(text).toContain("latest tail text");
      expect(text).not.toBe(readFileSync(path, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readHarnessSessionFromFile", () => {
  it("reads + parses a Codex fixture file end to end", () => {
    const s = readHarnessSessionFromFile("codex", join(FIX, "codex.jsonl"));
    expect(s?.context_window).toBe(258400);
    expect(s?.tokens_used).toBe(108569);
  });

  it("missing file → null (caller falls back to screen-parser)", () => {
    const s = readHarnessSessionFromFile("codex", join(FIX, "nope.jsonl"));
    expect(s).toBeNull();
  });
});

describe("loadHarnessSessionWithMeta", () => {
  it("returns parsed state with transcript mtime for quiescence checks", () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-harness-meta-"));
    const root = join(home, ".codex", "sessions", "2026", "06", "09");
    const path = join(root, "rollout-2026-06-09T09-16-20-sid-meta.jsonl");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "sid-meta", cwd: "/Users/e/Gits/cmuxlayer" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
      ].join("\n"),
    );
    const mtime = new Date("2026-06-09T10:00:00.000Z");
    utimesSync(path, mtime, mtime);

    try {
      const meta = loadHarnessSessionWithMeta("codex", "sid-meta", { home });
      expect(meta?.state.done).toBe(true);
      expect(meta?.mtime_ms).toBe(mtime.getTime());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("findHarnessSessionPath / loadHarnessSession (resolve by sessionId, no cwd)", () => {
  const home = mkdtempSync(join(tmpdir(), "cmux-harness-"));
  // Claude: ~/.claude/projects/<enc>/<sid>.jsonl
  mkdirSync(join(home, ".claude", "projects", "-Users-e-Gits-x"), {
    recursive: true,
  });
  cpSync(
    join(FIX, "claude.jsonl"),
    join(home, ".claude", "projects", "-Users-e-Gits-x", "sid-claude.jsonl"),
  );
  // Codex: ~/.codex/sessions/Y/M/D/rollout-<ts>-<sid>.jsonl (timestamp prefix)
  mkdirSync(join(home, ".codex", "sessions", "2026", "06", "04"), {
    recursive: true,
  });
  cpSync(
    join(FIX, "codex.jsonl"),
    join(
      home,
      ".codex",
      "sessions",
      "2026",
      "06",
      "04",
      "rollout-2026-06-04T22-46-15-sid-codex.jsonl",
    ),
  );
  // Cursor: ~/.cursor/projects/<enc>/agent-transcripts/<sid>/<sid>.jsonl
  mkdirSync(
    join(
      home,
      ".cursor",
      "projects",
      "Users-e-Gits-x",
      "agent-transcripts",
      "sid-cursor",
    ),
    { recursive: true },
  );
  cpSync(
    join(FIX, "cursor.jsonl"),
    join(
      home,
      ".cursor",
      "projects",
      "Users-e-Gits-x",
      "agent-transcripts",
      "sid-cursor",
      "sid-cursor.jsonl",
    ),
  );

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("finds Claude transcript by sessionId across project dirs (no cwd)", () => {
    const p = findHarnessSessionPath("claude", "sid-claude", { home });
    expect(p).toContain("/.claude/projects/-Users-e-Gits-x/sid-claude.jsonl");
  });

  it("finds Codex rollout file by sessionId suffix (timestamp-prefixed name)", () => {
    const p = findHarnessSessionPath("codex", "sid-codex", { home });
    expect(p).toContain("rollout-2026-06-04T22-46-15-sid-codex.jsonl");
  });

  it("finds Cursor transcript by sessionId subdir", () => {
    const p = findHarnessSessionPath("cursor", "sid-cursor", { home });
    expect(p).toContain("/agent-transcripts/sid-cursor/sid-cursor.jsonl");
  });

  it("loadHarnessSession end-to-end gives the real Codex window from JSONL", () => {
    const s = loadHarnessSession("codex", "sid-codex", { home });
    expect(s?.context_window).toBe(258400);
    expect(s?.context_pct).toBe(42);
  });

  it("unknown sessionId → null", () => {
    expect(loadHarnessSession("claude", "does-not-exist", { home })).toBeNull();
  });
});

describe("findLatestHarnessSessionIdentity (cwd → real session id)", () => {
  const home = mkdtempSync(join(tmpdir(), "cmux-harness-identity-"));

  mkdirSync(join(home, ".codex", "sessions", "2026", "06", "04"), {
    recursive: true,
  });
  writeFileSync(
    join(
      home,
      ".codex",
      "sessions",
      "2026",
      "06",
      "04",
      "rollout-2026-06-04T21-00-00-old.jsonl",
    ),
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        cwd: "/Users/etanheyman/Gits/other",
      },
    }),
  );
  cpSync(
    join(FIX, "codex.jsonl"),
    join(
      home,
      ".codex",
      "sessions",
      "2026",
      "06",
      "04",
      "rollout-2026-06-04T22-46-15-not-the-real-id.jsonl",
    ),
  );

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("Codex: scans transcripts for matching cwd and returns payload.session_meta id", () => {
    const identity = findLatestHarnessSessionIdentity(
      "codex",
      "/Users/etanheyman/Gits/brainlayer",
      { home },
    );

    expect(identity).toMatchObject({
      harness: "codex",
      session_id: "019e942c-0dda-76f2-bbca-0ef6e484d1c9",
    });
    expect(identity?.path).toContain("not-the-real-id.jsonl");
  });

  it("Codex: finds session_meta near the head of a large transcript", () => {
    const localHome = mkdtempSync(join(tmpdir(), "cmux-harness-large-head-"));
    const cwd = "/Users/e/Gits/cmuxlayer";
    const root = join(localHome, ".codex", "sessions", "2026", "07", "07");
    mkdirSync(root, { recursive: true });
    const file = join(root, "rollout-2026-07-07T00-00-00-large-head.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "large-head", cwd },
        }),
        `${JSON.stringify({ type: "assistant", message: "noise" })}\n`.repeat(
          9000,
        ),
      ].join("\n"),
      "utf8",
    );

    try {
      const identity = findLatestHarnessSessionIdentity("codex", cwd, {
        home: localHome,
      });

      expect(identity?.session_id).toBe("large-head");
      expect(identity?.path).toBe(file);
    } finally {
      rmSync(localHome, { recursive: true, force: true });
    }
  });

  it("Codex: skips malformed lines and session_meta entries missing ids", () => {
    const localHome = mkdtempSync(join(tmpdir(), "cmux-harness-bad-jsonl-"));
    const root = join(localHome, ".codex", "sessions", "2026", "06", "05");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "rollout-2026-06-05T20-00-00-jsonl-noise.jsonl"),
      [
        "{not-json",
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/Users/etanheyman/Gits/brainlayer" },
        }),
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
            cwd: "/Users/etanheyman/Gits/brainlayer",
          },
        }),
      ].join("\n"),
    );

    try {
      const identity = findLatestHarnessSessionIdentity(
        "codex",
        "/Users/etanheyman/Gits/brainlayer",
        { home: localHome },
      );

      expect(identity?.session_id).toBe(
        "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      );
    } finally {
      rmSync(localHome, { recursive: true, force: true });
    }
  });

  it("Cursor: matches launch prompts wrapped in user_query tags", () => {
    const localHome = mkdtempSync(join(tmpdir(), "cmux-harness-cursor-tags-"));
    const cwd = "/Users/etanheyman/Gits/cmuxlayer";
    const sessionId = "cursor-tagged-prompt";
    const root = join(
      localHome,
      ".cursor",
      "projects",
      "Users-etanheyman-Gits-cmuxlayer",
      "agent-transcripts",
      sessionId,
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>resume the launcher session</user_query>",
            },
          ],
        },
      }),
    );

    try {
      const identity = findLatestHarnessSessionIdentity("cursor", cwd, {
        home: localHome,
        expectedText: "resume the launcher session",
      });

      expect(identity).toMatchObject({
        harness: "cursor",
        session_id: sessionId,
      });
    } finally {
      rmSync(localHome, { recursive: true, force: true });
    }
  });

  it("Cursor: matches launch prompts split across adjacent text blocks", () => {
    const localHome = mkdtempSync(join(tmpdir(), "cmux-harness-cursor-split-"));
    const cwd = "/Users/etanheyman/Gits/cmuxlayer";
    const sessionId = "cursor-split-prompt";
    const root = join(
      localHome,
      ".cursor",
      "projects",
      "Users-etanheyman-Gits-cmuxlayer",
      "agent-transcripts",
      sessionId,
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "text", text: "resume the " },
            { type: "text", text: "launcher session" },
          ],
        },
      }),
    );

    try {
      const identity = findLatestHarnessSessionIdentity("cursor", cwd, {
        home: localHome,
        expectedText: "resume the launcher session",
      });

      expect(identity).toMatchObject({
        harness: "cursor",
        session_id: sessionId,
      });
    } finally {
      rmSync(localHome, { recursive: true, force: true });
    }
  });
});

describe("applyHarnessState (overlay; JSONL wins, screen is fallback)", () => {
  const screen = {
    token_count: 999,
    context_window: 1_000_000, // the WRONG screen-parser value for Codex
    context_pct: 87,
    model: "gpt-5.5 xhigh",
    extra: "kept",
  };

  it("Codex JSONL overrides the wrong 1M window + pct", () => {
    const out = applyHarnessState(screen, {
      harness: "codex",
      model: "gpt-5.5",
      tokens_used: 108569,
      context_window: 258400,
      context_pct: 42,
      last_text: "x",
      last_tool: "y",
      done: false,
    });
    expect(out.context_window).toBe(258400);
    expect(out.context_pct).toBe(42);
    expect(out.token_count).toBe(108569);
    expect(out.extra).toBe("kept"); // non-context fields untouched
  });

  it("Cursor (all-null JSONL) keeps the screen TUI-strip values", () => {
    const cursorScreen = { ...screen, context_window: null, context_pct: 22 };
    const out = applyHarnessState(cursorScreen, {
      harness: "cursor",
      model: null,
      tokens_used: null,
      context_window: null,
      context_pct: null,
      last_text: "x",
      last_tool: "y",
      done: false,
    });
    expect(out.context_pct).toBe(22); // screen value survives — TUI strip owns Cursor ctx%
    expect(out.context_window).toBeNull();
  });

  it("null state → parsed returned unchanged", () => {
    expect(applyHarnessState(screen, null)).toEqual(screen);
  });
});
