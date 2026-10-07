import { randomUUID } from 'node:crypto';
import { replyMarkerEvidence } from '../soak-live-checks.mjs';

export const targets = ['m1:prod-0.64.22', 'mbp:nightly'];
export const token = () => `XMAC_${randomUUID().replaceAll('-', '')}`;
export const text = screen => screen?.text ?? '';
export const prompt = marker => `Reply exactly ${marker} then stop.`;
// Reuse #998's attribution gate; raw prompt echoes/tool output cannot prove delivery.
export function replyCount(screen, marker) {
  const raw = text(screen);
  if (!replyMarkerEvidence({ content: raw }, marker).found) return 0;
  return raw.split('\n').filter(line => /^[⏺•]\s+/.test(line) &&
    line.trim().replace(/^[⏺•]\s*/, '') === marker).length;
}
export function idle(screen) {
  const lines = text(screen).trimEnd().split('\n'), index = lines.findLastIndex(line => /^[❯›]/u.test(line));
  return index >= 0 && /^[❯›]\s*(?:Ask Codex to do anything)?\s*$/u.test(lines[index]) &&
    !/(?:Working|Thinking|esc to interrupt)/iu.test(lines.slice(-6).join('\n'));
}
export const verified = r => r?.ok === true && r.submitted === true &&
  r.submit_verified === true && r.delivery_state === 'submitted' && !r.error_code;
export async function run(ctx, id, body) {
  const evidence = { receipt: [], screenBefore: [], screenAfter: [] }, notes = [], seats = new Set();
  const save = async (label, receipt) => {
    evidence.receipt.push({ label, value: receipt }); await ctx.receipt(label, receipt); return receipt;
  };
  const close = async agentId => {
    const result = await save('close', await ctx.close(agentId));
    if (result.agent_stopped !== true || result.surface_closed !== true) throw new Error('close_unverified');
    seats.delete(agentId);
  };
  const spawn = async (cli, bootPrompt) => {
    const seat = await ctx.spawn({ cli, model: cli === 'claude' ? 'haiku' : 'gpt-6-luna',
      ...(cli === 'codex' ? { effort: 'low' } : {}), role: 'worker', authority: 'worker',
      mcp_profile: 'sterile', force_new: true, ...(bootPrompt ? { prompt: bootPrompt } : {}), verbose: true });
    if (seat.agent_id) seats.add(seat.agent_id);
    await save('spawn', seat);
    if (!seat.agent_id || !seat.surface_id) throw new Error('spawn_missing_identity');
    return seat;
  };
  const observe = async (seat, marker, before = { text: '', source: 'new-seat-baseline', observed: false }) => {
    evidence.screenBefore.push(before);
    const after = await ctx.waitScreen(seat.surface_id,
      screen => replyCount(screen, marker) > replyCount(before, marker) && idle(screen), 30_000);
    evidence.screenAfter.push(after); return after;
  };
  const agree = (receipt, after, marker, before) => {
    const landed = replyCount(after, marker) > replyCount(before, marker);
    if (!landed) notes.push('missing_new_authored_reply');
    if (!verified(receipt)) notes.push(landed ? 'landed_with_unverified_receipt' : 'unverified_receipt');
  };
  let outcome;
  try { outcome = await body({ spawn, save, close, observe, agree, evidence, notes }); }
  catch (error) {
    notes.push(String(error));
    if (error.last) evidence.screenAfter.push(error.last);
    else for (const receipt of evidence.receipt.filter(r => r.label === 'spawn')) {
      try { evidence.screenAfter.push(await ctx.readScreen(receipt.value.surface_id)); } catch { /* runner records transport errors */ }
    }
  } finally {
    for (const agentId of seats) {
      try { await close(agentId); } catch (error) { notes.push(`cleanup: ${error}`); }
    }
  }
  const result = { status: notes.length ? 'FAIL' : outcome ?? 'PASS', evidence, notes };
  result.evidencePath = await ctx.artifact(`${id}.json`, result);
  return result;
}
