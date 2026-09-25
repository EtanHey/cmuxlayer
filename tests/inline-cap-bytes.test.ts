import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";

// #837: the inline cap is 500 UTF-8 bytes by default, the same line the
// fleet's client-side SEND-SIZE-GATE hook drew, so the hook can be deleted.
const previousMaxInline = process.env.CMUXLAYER_MAX_INLINE_CHARS;

async function freshModules() {
  vi.resetModules();
  const server = await import("../src/server.js");
  const policy = await import("../src/delivery/input-policy.js");
  return { server, policy };
}

function parse(result: any) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

describe("inline cap: 500 UTF-8 bytes (#837)", () => {
  beforeEach(() => {
    delete process.env.CMUXLAYER_MAX_INLINE_CHARS;
  });

  afterEach(() => {
    if (previousMaxInline === undefined) delete process.env.CMUXLAYER_MAX_INLINE_CHARS;
    else process.env.CMUXLAYER_MAX_INLINE_CHARS = previousMaxInline;
    vi.resetModules();
  });

  it("refuses a 501-byte send_to.text without allow_long_inline", async () => {
    const { server } = await freshModules();
    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const mcp = server.createServer(
      withTestSurfaceObserver({ exec: mockExec }),
    );
    const sendTo = (mcp as any)._registeredTools["send_to"];
    expect(sendTo).toBeDefined();

    const refused = parse(
      await sendTo.handler(
        { mode: "agent", agent_id: "no-such-agent", text: "x".repeat(501) },
        {} as any,
      ),
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("send_to.text is 501 bytes");
    expect(refused.error).toContain("CMUXLAYER_MAX_INLINE_CHARS=500");

    // At the cap the size check passes; the send fails later, on the target.
    const atCap = parse(
      await sendTo.handler(
        { mode: "agent", agent_id: "no-such-agent", text: "x".repeat(500) },
        {} as any,
      ),
    );
    expect(atCap.error ?? "").not.toContain("CMUXLAYER_MAX_INLINE_CHARS");
  });

  it("measures UTF-8 bytes, not characters", async () => {
    const { policy } = await freshModules();
    // 250 characters, 750 bytes.
    const text = "€".repeat(250);
    expect(() =>
      policy.assertInlineInputAllowed({ tool: "send_to", arg: "text", value: text }),
    ).toThrow(/send_to\.text is 750 bytes/);
  });

  it("keeps allow_long_inline and the env override (floor 500)", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "900";
    const { policy } = await freshModules();
    expect(policy.SEND_INPUT_MAX_INLINE_CHARS).toBe(900);
    expect(() =>
      policy.assertInlineInputAllowed({
        tool: "send_to",
        arg: "text",
        value: "x".repeat(2_000),
        allowLongInline: true,
      }),
    ).not.toThrow();

    process.env.CMUXLAYER_MAX_INLINE_CHARS = "499";
    const below = await freshModules();
    expect(below.policy.SEND_INPUT_MAX_INLINE_CHARS).toBe(500);
  });
});
