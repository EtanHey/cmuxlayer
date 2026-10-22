import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { refuseUnderT3Code } from "../src/t3-code-guard.js";

const underT3 = refuseUnderT3Code({ writeStderr: () => {} });
const entrypoints = [
  ...["index", "app-server-index", "proxy", "daemon", "resource-guard", "mcp-reaper"]
    .map((name) => `src/${name}.ts`),
  "scripts/xmac/lead-proxy.mjs",
];

function checkEntrypoint(entry: string, ancestry: "t3" | "allowed" | "real") {
  const home = mkdtempSync(join(tmpdir(), "t3-refusal-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home,
      CMUXLAYER_CONFIG_FILE: join(home, "missing-env.sh"),
      CMUXLAYER_DAEMON_SOCKET: join(home, "daemon.sock"),
      CMUX_SOCKET_PATH: join(home, "cmux.sock"),
      CMUXLAYER_FORCE_INPROCESS: "1",
    };
    delete env.T3CODE_CLI_PATH;
    const loader = new URL("./fixtures/t3-code-startup-loader.mjs", import.meta.url);
    loader.searchParams.set("ancestry", ancestry);
    const imports = entry.endsWith(".mjs") ? [] : ["--import", "tsx"];
    const child = spawnSync("node", [...imports, "--import", loader.href, resolve(entry)], {
      env, encoding: "utf8", timeout: 10_000,
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(ancestry === "allowed" ? 23 : 0);
    expect(child.stdout).toBe("");
    expect(child.stderr.trim().split("\n")).toHaveLength(1);
    if (ancestry === "allowed") expect(child.stderr).toBe("cmuxlayer-test: ancestry allowed\n");
    else expect(child.stderr).toMatch(/^cmuxlayer: refusing to start under T3 Code \(ancestor pid \d+: .+T3 Code.*\)\n$/);
    expect(readdirSync(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.each(["t3", "allowed"] as const)("injected %s ancestry", (ancestry) => {
  it.each(entrypoints)("%s reaches the guard before protocol or host work", (entry) => {
    checkEntrypoint(entry, ancestry);
  });
});

// Extra acceptance coverage on real T3 hosts; deterministic cases above run in CI.
it.runIf(underT3).each(entrypoints)("%s refuses real T3 ancestry without its env hint", (entry) => {
  checkEntrypoint(entry, "real");
});
