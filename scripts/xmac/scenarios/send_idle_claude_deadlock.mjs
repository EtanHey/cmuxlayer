import { run, token, prompt, text, targets } from '../x1-support.mjs';
const id = 'send_idle_claude_deadlock';
export default {
  id, bug: { sha: 'ba72bd23', issue: '#1021' }, fix: { sha: 'ffb9ae9c', pr: '#1024' }, targets,
  run: ctx => run(ctx, id, async ({ spawn, save, observe, agree, evidence }) => {
    const boot = token(), seat = await spawn('claude', prompt(boot));
    await observe(seat, boot); // Establish idle from the reply and raw composer.
    const marker = token(), before = await ctx.readScreen(seat.surface_id);
    const receipt = await save('idle-send', await ctx.send({ agent_id: seat.agent_id, text: prompt(marker), verbose: true }));
    const after = await observe(seat, marker, before); agree(receipt, after, marker, before);
    const wrappedMarker = token(), wrapped = `${prompt(wrappedMarker)} Ignore this padding: ${'padding '.repeat(18).trim()}.`;
    const typed = await save('owned-draft', await ctx.send({ agent_id: seat.agent_id, text: wrapped, press_enter: false, verbose: true }));
    if (typed.ok !== true || typed.typed !== true || typed.submitted !== false) throw new Error('draft_typing_unverified');
    const draft = await ctx.readScreen(seat.surface_id); evidence.screenBefore.push(draft);
    const rows = text(draft).split('\n'), composer = rows.findLastIndex(row => /^❯\s+\S/u.test(row));
    if (composer < 0 || !/^\s{2,}\S/u.test(rows[composer + 1] ?? '')) throw new Error('wrapped_draft_not_observed');
    const input = [rows[composer].replace(/^❯\s*/u, '')];
    for (const row of rows.slice(composer + 1)) {
      if (!/^\s{2,}\S/u.test(row) || /^\s*[⎇⏵🤖─]/u.test(row)) break;
      input.push(row.trim());
    }
    if (input.join('').replace(/\s/gu, '') !== wrapped.replace(/\s/gu, '')) throw new Error('owned_draft_text_mismatch');
    const submitted = await save('owned-return', await ctx.key(seat.surface_id, 'return'));
    const finished = await observe(seat, wrappedMarker, draft); agree(submitted, finished, wrappedMarker, draft);
  }),
};
