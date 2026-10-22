import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { refuseUnderT3Code } from "../src/t3-code-guard.js";

// This real-process acceptance check applies on T3 hosts. The pure-chain tests
// cover both allowed and refused ancestry everywhere, including hosted CI.
const underT3 = refuseUnderT3Code({ writeStderr: () => {} });

it.runIf(underT3).each([
  "index", "app-server-index", "proxy", "daemon", "resource-guard", "mcp-reaper",
])("%s exits cleanly under T3 before writing protocol frames or host state", (entry) => {
  const home = mkdtempSync(join(tmpdir(), "t3-refusal-"));
  try {
    const env = { ...process.env, HOME: home,
      CMUXLAYER_CONFIG_FILE: join(home, "missing-env.sh"),
      CMUXLAYER_DAEMON_SOCKET: join(home, "daemon.sock"),
      CMUX_SOCKET_PATH: join(home, "cmux.sock"),
      CMUXLAYER_FORCE_INPROCESS: "1",
    };
    delete env.T3CODE_CLI_PATH;
    const child = spawnSync(process.execPath, ["--import", "tsx", resolve(`src/${entry}.ts`)], {
      env, encoding: "utf8", timeout: 10_000,
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr.trim().split("\n")).toHaveLength(1);
    expect(child.stderr).toMatch(/^cmuxlayer: refusing to start under T3 Code \(ancestor pid \d+: .+T3 Code.*\)\n$/);
    expect(readdirSync(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
