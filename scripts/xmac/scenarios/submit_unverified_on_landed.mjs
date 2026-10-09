import { run, token, prompt, targets } from '../x1-support.mjs';
const id = 'submit_unverified_on_landed';
export default {
  id, bug: { sha: 'ff6a560e', issue: '#1000' }, fix: { sha: null, issue: '#1000', status: 'pending' }, targets,
  run: ctx => run(ctx, id, async ({ spawn, save, observe, agree }) => {
    const boot = token(), seat = await spawn('claude', prompt(boot));
    await observe(seat, boot);
    const marker = token(), repeatedPrompt = prompt(marker);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await ctx.readScreen(seat.surface_id);
      const receipt = await save(`repeat-${attempt}`, await ctx.send({ agent_id: seat.agent_id, text: repeatedPrompt, verbose: true }));
      const after = await observe(seat, marker, before); agree(receipt, after, marker, before);
    }
  }),
};
