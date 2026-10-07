import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import boot from '../scripts/xmac/scenarios/spawn_boot_false_unsubmitted.mjs';
import idle from '../scripts/xmac/scenarios/send_idle_claude_deadlock.mjs';
import overlay, { variant } from '../scripts/xmac/scenarios/send_under_codex_overlays.mjs';
import repeated from '../scripts/xmac/scenarios/submit_unverified_on_landed.mjs';
import { idle as screenIdle, replyCount } from '../scripts/xmac/x1-support.mjs';

const capture = (name: string) => readFileSync(new URL(`./fixtures/composer-overlays/${name}.txt`, import.meta.url), 'utf8');
function context(opts: any = {}) {
  let screen = '', prompt = '', agent = 0;
  const submitted = { ok: true, submitted: true, submit_verified: true, delivery_state: 'submitted' };
  const reply = (text: string) => {
    const marker = text.match(/Reply exactly (\S+)/)?.[1];
    screen += opts.echoOnly ? `\n❯ ${text}\n  ${marker}` : `\n⏺ ${marker}\n❯\n`;
  };
  const ctx: any = {
    spawn: vi.fn(async (args: any) => {
      screen = args.prompt ? '' : opts.overlays?.[agent] ?? '›\n';
      agent++; if (args.prompt) reply(args.prompt);
      return { ok: true, agent_id: `seat-${agent}`, surface_id: `surface:${agent}`,
        boot_prompt_delivered: true, boot_prompt_submit_verified: true, ...opts.spawn };
    }),
    send: vi.fn(async (args: any) => {
      prompt = args.text;
      if (args.press_enter === false) screen += `\n❯ ${prompt.slice(0, 70)}\n  ${prompt.slice(70)}\n`;
      else if (!opts.noLanding) reply(prompt);
      return args.press_enter === false ? { ok: true, typed: true, submitted: false } : { ...submitted, ...opts.send };
    }),
    key: vi.fn(async (_surface: string, key: string) => {
      expect(key).toBe('return'); if (!opts.noLanding) reply(prompt);
      return { ...submitted, ...opts.send };
    }),
    readScreen: vi.fn(async () => ({ text: screen })),
    waitScreen: vi.fn(async (_surface: string, predicate: any) => {
      if (!predicate({ text: screen })) throw new Error('screen deadline');
      return { text: screen };
    }),
    receipt: vi.fn(), artifact: vi.fn(async () => 'artifact.json'),
    close: vi.fn(async () => ({ agent_stopped: true, surface_closed: true })),
  };
  return ctx;
}

describe('X1 raw-screen scenario contracts (synthetic ctx only)', () => {
  it('boot agrees with a newly authored reply and closes the seat', async () => {
    const ctx = context(); expect((await boot.run(ctx)).status).toBe('PASS');
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(ctx.spawn.mock.calls[0][0]).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
  });
  it('catches a false boot_unsubmitted despite a landed reply', async () => {
    expect((await boot.run(context({ spawn: { ok: false, spawn_state: 'boot_unsubmitted', boot_prompt_delivered: false } }))).status).toBe('FAIL');
  });
  it('never counts an echoed prompt or receipt as a reply', async () => {
    for (const scenario of [boot, idle, repeated]) expect((await scenario.run(context({ echoOnly: true }))).status).toBe('FAIL');
  });
  it('sends to idle Claude then submits its owned wrapped draft exactly once', async () => {
    const ctx = context(); expect((await idle.run(ctx)).status).toBe('PASS');
    expect(ctx.spawn.mock.calls[0][0].model).toBe('haiku');
    expect(ctx.key).toHaveBeenCalledTimes(1);
    expect(ctx.send.mock.calls.at(-1)[0].press_enter).toBe(false);
  });
  it('rejects foreign-draft refusal and closes after an observation timeout', async () => {
    for (const opts of [{ send: { ok: false, error_code: 'blocked_by_foreign_draft' } }, { noLanding: true }]) {
      const ctx = context(opts); expect((await idle.run(ctx)).status).toBe('FAIL');
      expect(ctx.close).toHaveBeenCalledTimes(1);
    }
  });
  it('tests each observed overlay without selecting setup or trusting hooks', async () => {
    const security = capture('codex-boot').replaceAll('Daybreak', 'ordinary');
    for (const raw of [security, capture('codex-hooks-review'), capture('codex-boot')]) {
      const ctx = context({ overlays: [raw] }); expect((await overlay.run(ctx)).status).toBe('PASS');
      expect(ctx.key).not.toHaveBeenCalled(); expect(ctx.close).toHaveBeenCalledTimes(1);
    }
  });
  it('fails absent overlay coverage even when sends work', async () => {
    const ctx = context(); expect((await overlay.run(ctx)).status).toBe('PRECONDITION_ABSENT');
    expect(ctx.send).not.toHaveBeenCalled(); expect(ctx.close).toHaveBeenCalledTimes(1);
  });
  it('repeats exactly the same prompt and requires a second authored reply', async () => {
    const ctx = context(); expect((await repeated.run(ctx)).status).toBe('PASS');
    expect(ctx.send.mock.calls).toHaveLength(2);
    expect(ctx.send.mock.calls[0][0].text).toBe(ctx.send.mock.calls[1][0].text);
  });
  it('catches landed messages with false submit_unverified receipts', async () => {
    const ctx = context({ send: { ok: false, submitted: false, submit_verified: false, error_code: 'submit_unverified' } });
    const result = await repeated.run(ctx);
    expect(result.status).toBe('FAIL'); expect(result.notes).toContain('landed_with_unverified_receipt');
  });
  it('rejects true receipts without screen proof and records evidence', async () => {
    const ctx = context({ noLanding: true }); const result = await repeated.run(ctx);
    expect(result.status).toBe('FAIL'); expect(ctx.artifact).toHaveBeenCalled();
  });
  it('reports cleanup failure instead of passing', async () => {
    const ctx = context(); ctx.close.mockResolvedValue({ surface_closed: false });
    expect((await boot.run(ctx)).status).toBe('FAIL');
  });
  it('accepts the real Codex idle placeholder, but rejects working or typed drafts', () => {
    const screen = { text: capture('codex-boot') };
    expect(screenIdle(screen)).toBe(true);
    expect(screenIdle({ text: screen.text.replace('Ask Codex to do anything', 'HUMAN_DRAFT') })).toBe(false);
    expect(screenIdle({ text: screen.text + '\n• Working (2s • esc to interrupt)' })).toBe(false);
    expect(screenIdle({ text: '❯\n⏺ Old reply\n❯ HUMAN_DRAFT' })).toBe(false);
  });
  it('does not count identical old replies as a new submission', async () => {
    const ctx = context(); let sends = 0;
    const original = ctx.send.getMockImplementation();
    ctx.send.mockImplementation(async (args: any) => {
      if (++sends === 2) return { ok: true, submitted: true, submit_verified: true, delivery_state: 'submitted' };
      return original(args);
    });
    expect((await repeated.run(ctx)).status).toBe('FAIL');
  });
  it('rejects marker text in a tools result or a wrapped prompt', () => {
    for (const raw of ['⏺ Bash(command)\n  ⎿ MARKER\n❯', '❯ Reply exactly MARKER\n  MARKER\n❯']) {
      expect(replyCount({ text: raw }, 'MARKER')).toBe(0);
    }
  });
  it('retains the independent last screen on WaitTimeout', async () => {
    const ctx = context(), last = { text: '❯ pending draft' };
    ctx.waitScreen.mockRejectedValue(Object.assign(new Error('WaitTimeout'), { last }));
    const result = await boot.run(ctx);
    expect(result.evidence.screenAfter).toContainEqual(last);
    expect(ctx.close).toHaveBeenCalledWith('seat-1');
  });
  it('does not mistake a quoted old overlay for an active one', () => {
    expect(variant({ text: capture('codex-boot') + '\n• A later response\n›\n' })).toBeNull();
    expect(variant({ text: capture('codex-hooks-review').replace('  3. Continue without trusting (hooks won\'t run)', '') })).toBeNull();
  });
  it('refuses Return if any foreign words appear in the owned draft', async () => {
    const ctx = context(), read = ctx.readScreen.getMockImplementation();
    ctx.readScreen.mockImplementation(async () => {
      const screen = await read(); return { text: screen.text.replace('padding padding', 'padding HUMAN_WORDS padding') };
    });
    const result = await idle.run(ctx);
    expect(result.status).toBe('FAIL'); expect(result.notes.join(' ')).toContain('owned_draft_text_mismatch');
    expect(ctx.key).not.toHaveBeenCalled(); expect(ctx.close).toHaveBeenCalledTimes(1);
  });
});
