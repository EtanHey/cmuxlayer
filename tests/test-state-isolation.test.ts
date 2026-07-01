import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createServerContext,
  type CmuxServerContext,
} from "../src/server.js";

const LIVE_STATE_DIR = join(homedir(), ".local", "state", "cmux-agents");

const contexts: CmuxServerContext[] = [];

afterEach(() => {
  while (contexts.length > 0) {
    contexts.pop()?.dispose();
  }
});

describe("test state isolation", () => {
  it("does not use the live fleet state dir when Vitest omits stateDir", () => {
    const context = createServerContext({ skipAgentLifecycle: true });
    contexts.push(context);

    expect(process.env.VITEST).toBe("true");
    expect(context.stateDir).not.toBe(LIVE_STATE_DIR);
    expect(context.stateDir).toContain("cmuxlayer-vitest-state-");
    expect(existsSync(context.stateDir)).toBe(true);

    const stateDir = context.stateDir;
    context.dispose();
    contexts.pop();
    expect(existsSync(stateDir)).toBe(false);
  });
});
