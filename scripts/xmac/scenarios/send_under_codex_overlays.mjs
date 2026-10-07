import { run, token, prompt, text, targets } from '../x1-support.mjs';
const id = 'send_under_codex_overlays';
// Opportunistic live coverage. R1's captured-frame replay remains authoritative.
export function variant(screen) {
  const lines = text(screen).trimEnd().split('\n').slice(-40);
  const footer = lines.findLastIndex(line => /^\s*(?:Press a number to choose · esc to dismiss · type to continue|enter confirm · esc skip)\s*$/u.test(line));
  if (footer < 0) return null;
  const tail = lines.slice(footer + 1).filter(line => line.trim());
  if (tail.some(line => /^[⏺•]|Working|esc to interrupt/u.test(line)) || tail.filter(line => /^›/u.test(line)).length > 1) return null;
  const raw = lines.slice(Math.max(0, footer - 12), footer).join('\n');
  if (/enter confirm/u.test(lines[footer])) return /Hooks need review/u.test(raw) &&
    /(?:›\s*)?1\. Review hooks/u.test(raw) && /(?:›\s*)?2\. Trust all/u.test(raw) &&
    /(?:›\s*)?3\. Continue without trusting/u.test(raw) && /› [123]\./u.test(raw) ? 'hooks_review' : null;
  if (!/› 1\. Set up/u.test(raw)) return null;
  return /Daybreak/u.test(raw) ? 'daybreak' : /security/iu.test(raw) ? 'security' : null;
}
export default {
  id, bug: { sha: '7f26603f', issue: '#1007' }, fix: { sha: '64260ba3', pr: '#1020' }, targets,
  authoritativeReplay: { row: 'send_under_codex_banner', hooksFixture: 'tests/fixtures/composer-overlays/codex-hooks-review.txt' },
  run: ctx => run(ctx, id, async ({ spawn, save, observe, agree, evidence }) => {
    const seat = await spawn('codex'), before = await ctx.readScreen(seat.surface_id), kind = variant(before);
    evidence.screenBefore.push(before);
    evidence.authoritativeReplay = 'send_under_codex_banner'; evidence.overlayVariant = kind;
    if (!kind) { evidence.precondition = 'No live overlay observed; not covered by this run.'; return 'PRECONDITION_ABSENT'; }
    const marker = token();
    // No recovery key, menu number, setup command, or trust action. Test send_to itself.
    const receipt = await save(kind, await ctx.send({ agent_id: seat.agent_id, text: prompt(marker), verbose: true }));
    const after = await observe(seat, marker, before); agree(receipt, after, marker, before);
  }),
};
