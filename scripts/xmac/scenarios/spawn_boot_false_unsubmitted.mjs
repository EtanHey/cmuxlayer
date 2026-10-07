import { run, token, prompt, targets } from '../x1-support.mjs';
const id = 'spawn_boot_false_unsubmitted';
export default {
  id, bug: { sha: '14aa55b5', issue: '#1019' }, fix: { sha: null, pr: '#1019', status: 'pending' }, targets,
  run: ctx => run(ctx, id, async ({ spawn, observe, notes }) => {
    const marker = token(), seat = await spawn('codex', prompt(marker));
    await observe(seat, marker);
    if (seat.ok !== true || seat.boot_prompt_delivered !== true ||
      seat.boot_prompt_submit_verified !== true || seat.spawn_state === 'boot_unsubmitted') {
      notes.push('landed_with_false_boot_receipt');
    }
  }),
};
