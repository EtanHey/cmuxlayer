import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { inboxBaseDir } from "../src/inbox.js";
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
  it("never resolves the real fleet agents root during a Vitest run", () => {
    const realAgents = join(userInfo().homedir, ".cmux", "agents");
    const runRoot = process.env.CMUXLAYER_TEST_TMP_ROOT;
    expect(runRoot).toBeTruthy();
    expect(homedir()).toBe(join(runRoot!, "home"));
    expect(inboxBaseDir()).toBe(join(runRoot!, "home", ".cmux", "agents"));
    expect(process.env.CMUXLAYER_INBOX_BASE_DIR).toBe(join(runRoot!, "agents"));
    expect(process.env.CMUX_AGENTS_DIR).toBe(join(runRoot!, "agents"));
    expect(process.env.CMUXLAYER_STATE_DIR).toBe(join(runRoot!, "state"));
    expect(inboxBaseDir()).not.toBe(realAgents);
  });

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
