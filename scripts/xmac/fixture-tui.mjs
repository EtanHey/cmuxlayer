import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createFixtureComposer } from "./fixture-composer.mjs";

export async function runFixtureTui(cli, args = process.argv.slice(4)) {
  if (!["codex", "claude"].includes(cli)) throw new Error("unsupported fixture CLI");
  const env = process.env, root = realpathSync(env.CMUXLAYER_XMAC_FIXTURE_DIR);
  const privatePath = path => {
    if (!path || !resolve(path).startsWith(root + "/")) throw new Error("fixture write escapes private root");
    // All generated parents must remain beneath this run, including symlinks.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = realpathSync(dirname(path));
    if (parent !== root && !parent.startsWith(root + "/")) throw new Error("fixture parent escapes private root");
    return path;
  };
  if (!process.stdin.isTTY) throw new Error("fixture requires a real terminal");
  const resumed = args.includes("resume") ? args[args.indexOf("resume") + 1] :
    args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
  const session = resumed ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(session)) throw new Error("fixture resume identity invalid");
  const cwd = process.cwd(), surface = env.CMUX_SURFACE_ID;
  if (!surface) throw new Error("fixture surface identity absent");
  const transcript = privatePath(cli === "codex" ? join(env.CODEX_HOME, "sessions", `rollout-fixture-${session}.jsonl`) :
    join(env.CMUXLAYER_HARNESS_HOME, ".claude/projects", cwd.replaceAll("/", "-"), `${session}.jsonl`));
  const event = value => appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...value }) + "\n", { mode: 0o600 });
  if (!resumed && cli === "codex") event({ type: "session_meta", payload: { id: session, cwd } });
  if (cli === "codex") event({ type: "turn_context", payload: { model: "gpt-6-luna" } });
  // A genuine hook-shaped registration from this fixture process and real PTY.
  const register = () => appendFileSync(privatePath(env.CMUXLAYER_SESSION_REGISTRY), JSON.stringify({ session_id: session,
    surface_uuid: surface, cwd, pid: process.pid, cli, launcher: `xmac${cli === "codex" ? "Codex" : "Claude"}`,
    session_path: transcript, ts: Date.now() }) + "\n", { mode: 0o600 });
  // macOS process start evidence has whole-second precision. Register after
  // that initial second so the product can qualify this real PID unambiguously.
  setTimeout(register, 1200);
  const events = privatePath(join(root, "events", `${surface}.json`));
  const capture = name => readFileSync(fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url)), "utf8");
  const frame = capture(cli === "codex" ? "codex-0.157/idle-empty.txt" : "composer-overlays/claude-boot.txt")
    .replaceAll("GPT-6-Sol medium", "GPT-6-Luna low");
  let leadClient;
  const respond = async text => {
    const report = text.match(/^Write "(DONE_[A-Z0-9_]+)" as the final line of "([^"\n]+)"\./);
    if (report) {
      // Contract reports live in the daemon's private state, separate from fixtures.
      const stateRoot = realpathSync(env.CMUXLAYER_STATE_DIR), path = resolve(report[2]);
      if (!path.startsWith(stateRoot + "/") || !realpathSync(dirname(path)).startsWith(stateRoot + "/")) throw new Error("fixture report escapes state root");
      writeFileSync(path, report[1] + "\n", { mode: 0o600 });
    }
    if (text.startsWith("Use cmuxlayer to spawn one Claude")) {
      const token = text.match(/Reply exactly ([A-Za-z0-9_]+)_CHILD/)?.[1];
      if (!token || !env.CMUXLAYER_XMAC_LEAD_CONFIG) throw new Error("fixture lead instruction/config absent");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const config = JSON.parse(readFileSync(env.CMUXLAYER_XMAC_LEAD_CONFIG, "utf8")).mcpServers.cmuxlayer;
      leadClient ??= new Client({ name: "xmac-fixture-lead", version: "1" });
      await leadClient.connect(new StdioClientTransport({ ...config, env: { ...env, ...config.env }, stderr: "inherit" }));
      const { unwrap } = await import("./ctx.mjs");
      const result = unwrap(await leadClient.callTool({ name: "spawn_agent", arguments: {
        cli: "claude", model: "haiku", effort: "low", worktree: false, mcp_profile: "sterile",
        prompt: `Reply exactly ${token}_CHILD. Use no tools.` } }, undefined, { timeout: 90_000 }));
      if (!result.ok) throw new Error("fixture child spawn failed");
      return token;
    }
    return text.match(/Reply exactly ([A-Za-z0-9_]+)/i)?.[1] ?? (text.startsWith("Run sleep ") ? "BUSY_DONE" : "FIXTURE_ACK");
  };
  const composer = createFixtureComposer({ accepted: text => {
    event(cli === "codex" ? { type: "event_msg", payload: { type: "user_message", message: text } } :
      { type: "user", sessionId: session, cwd, message: { role: "user", content: [{ type: "text", text }] } });
  }, respond, changed: () => render() });
  let recorded = 0;
  function render() {
    const { state } = composer;
    while (recorded < state.replies.length) {
      const text = state.replies[recorded++];
      event(cli === "codex" ? { type: "event_msg", payload: { type: "agent_message", message: text } } :
        { type: "assistant", sessionId: session, message: { role: "assistant", model: "haiku", stop_reason: "end_turn", content: [{ type: "text", text }] } });
    }
    const prompt = cli === "codex" ? "›" : "❯", assistant = cli === "codex" ? "•" : "⏺";
    const history = state.turns.map((text, index) => `${prompt} ${text}\n${state.replies[index] ? `${assistant} ${state.replies[index]}` : ""}`).join("\n");
    const busy = state.phase === "working" || state.phase === "submitted";
    const pending = state.pending.map(item => `• ${item.mode === "queue" ? "Queued follow-up inputs" : "Messages to be submitted after next tool call"}\n  ↳ ${item.text}`).join("\n");
    const draft = cli === "claude" ? (state.draft.match(/.{1,80}/gu) ?? []).join("\n  ") : state.draft;
    const composerRow = `${history}\n${busy ? cli === "codex" ? "Working (1s • esc to interrupt)" : "✻ Thinking… (esc to interrupt)" : ""}\n${pending}\n${prompt} ${draft || (cli === "codex" ? "Ask Codex to do anything" : "")}`;
    let rendered = cli === "codex" ? frame.replace("› Ask Codex to do anything", composerRow) : frame.replace(/^❯.*$/mu, composerRow);
    // The first Codex seat deterministically exercises the captured Daybreak row.
    if (cli === "codex" && !resumed && !state.turns.length && env.CMUXLAYER_XMAC_OVERLAY === "daybreak") rendered = capture("composer-overlays/codex-boot.txt").replace("› Ask Codex to do anything", `${prompt} ${draft}`);
    process.stdout.write("\x1b[2J\x1b[H" + rendered.split("\n").filter(line => line.trim()).join("\r\n") + "\r\n");
    writeFileSync(events + ".tmp", JSON.stringify({ ...state, pid: process.pid, cli, surface, session,
      argv: args, transcript, fixture: true })); renameSync(events + ".tmp", events);
  }
  process.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdin.resume(); render();
  process.stdin.on("data", data => { if (data.includes("\x03")) process.exit(0); composer.input(data); });
}
