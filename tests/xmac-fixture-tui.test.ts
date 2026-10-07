import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { makeSelfRegistrationSessionResolver } from "../src/self-registration";
import { parseHarnessSession } from "../src/harness-session";
import { parseScreen } from "../src/screen-parser";

it.each(["codex", "claude"])("%s fixture serves a private real PTY and hook-shaped identity without a model", cli => {
  const evidence = JSON.parse(execFileSync("python3", ["tests/fixtures/xmac-fixture-pty.py", cli,
    resolve("."), process.execPath], { encoding: "utf8", timeout: 15_000 }));
  const { state, registration, transcript } = evidence;
  expect(state.replies).toEqual(["PTY_REPLY"]);
  expect(state.draft).toContain("cmuxlayer contract");
  expect(evidence.screen).toContain(cli === "codex" ? "• PTY_REPLY" : "⏺ PTY_REPLY");
  expect(parseScreen(evidence.screen).status).toBe("draft_pending");
  expect(parseHarnessSession(cli as any, transcript).last_text).toBe("PTY_REPLY");
  const lookup = makeSelfRegistrationSessionResolver({ readFile: () => JSON.stringify(registration) + "\n",
    now: () => registration.ts + 1 });
  const result = lookup({ cli, surface_uuid: registration.surface_uuid, launch_cwd: registration.cwd,
    created_at: new Date(registration.ts - 1500).toISOString(), surface_provenance: "cmuxlayer_spawn" } as any);
  expect(result).toMatchObject({ session_id: state.session, pid: state.pid, path: state.transcript });
}, 20_000);
