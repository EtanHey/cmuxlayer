import { randomUUID } from "node:crypto";
import { replyMarkerEvidence } from "../soak-live-checks.mjs";

export const targets = ["m1:prod-0.64.22", "mbp:nightly"];
export function requireEvidence(condition, code) {
  if (!condition) throw new Error(code);
}
export const raw = (screen) => typeof screen?.text === "string" ? screen.text : "";
export const ready = (screen) => /(?:OpenAI Codex|GPT-6-Luna)/i.test(raw(screen)) &&
  /(?:^|\n)\s*›[ \t]*(?:Ask Codex to do anything)?[ \t]*(?:\n|$)/u.test(raw(screen)) &&
  !/(?:Working|Thinking)\s*\([^\n]*esc to interrupt/i.test(raw(screen));
export const replied = (screen, token) => replyMarkerEvidence({ content: raw(screen) }, token).found;
export const marker = (ctx, id) => `XMAC_${id.slice(0, 24)}_${(ctx.runId ?? randomUUID()).replace(/\W/g, "").slice(0, 12)}`;

export async function record(ctx, evidence, label, value) {
  evidence.receipt ??= {};
  evidence.receipt[label] = value;
  await ctx.receipt(label, value);
  return value;
}
export async function spawn(ctx, evidence, prompt, overrides = {}) {
  const seat = await record(ctx, evidence, "spawn", await ctx.spawn({
    cli: "codex", model: "gpt-6-luna", effort: "low", role: "worker",
    authority: "worker", placement: "right", worktree: false,
    mcp_profile: "sterile", force_new: true, prompt, ...overrides,
  }));
  requireEvidence(seat.ok === true && seat.agent_id && seat.surface_id, "spawn_failed");
  return seat;
}
export async function observe(ctx, evidence, surface, predicate, label = "screenAfter") {
  try {
    const screen = await ctx.waitScreen(surface, predicate, 30_000);
    evidence[label] = screen;
    requireEvidence(Boolean(raw(screen)) && predicate(screen), "screen_unproven");
    return screen;
  } catch (error) {
    if (error.last) evidence[label] = error.last;
    throw error;
  }
}
export async function resume(ctx, evidence, seat) {
  const closed = await record(ctx, evidence, "close", await ctx.close(seat.agent_id));
  requireEvidence(closed.ok === true && closed.agent_stopped === true && closed.surface_closed === true, "close_unproven");
  const resumed = await record(ctx, evidence, "resume", await ctx.resume(seat.agent_id, { force: true, focus: false }));
  requireEvidence(resumed.ok === true && resumed.resumed === true &&
    resumed.agent_id === seat.agent_id && resumed.surface_id, "resume_unproven");
  await observe(ctx, evidence, resumed.surface_id, ready);
  return resumed;
}
export function scenario(spec, execute) {
  return { targets, ...spec, async run(ctx) {
    const evidence = {};
    let status = "PASS", notes = [];
    try {
      requireEvidence(this.targets.includes(`${ctx.target?.host}:${ctx.target?.cmux}`), "unsupported_target");
      await execute(ctx, evidence);
    } catch (error) { status = "FAIL"; notes.push(error.message); }
    try { evidence.path = await ctx.artifact(this.id, { status, evidence, notes }); }
    catch (error) { status = "FAIL"; notes.push(`artifact_failed:${error.message}`); }
    // ctx.spawn and ctx.resume enroll seats in the runner's finally sweep.
    return { status, evidence, notes };
  } };
}
