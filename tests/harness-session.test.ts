import { afterAll, describe, expect, it } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  applyHarnessState,
  harnessJsonlEnabled,
} from "../src/harness-session.js";

const FIX = join(__dirname, "fixtures", "harness");
const read = (name: string) => readFileSync(join(FIX, name), "utf8");

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

  it("GPT-5/Codex family = 400K total window (NOT 1M)", () => {
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
