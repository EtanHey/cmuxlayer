import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { nofileExecSpec, withRaisedNofileSoftLimit } from "../src/nofile-limit.js";

const hostHardText = execFileSync("/bin/sh", ["-c", "ulimit -Hn"], {
  encoding: "utf8",
}).trim();
const hostHard = hostHardText === "unlimited" ? Infinity : Number(hostHardText);

function runUnderSoftLimit(limit: number, command: string): number {
  const result = spawnSync("/bin/sh", ["-c", `ulimit -Sn ${limit}; ${command}`], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

describe("nofile launch wrappers", () => {
  it("leaves a fish or unknown shell launch intact", () => {
    const command = "cmuxlayerCodex -s --worker";
    expect(withRaisedNofileSoftLimit(command, "/opt/homebrew/bin/fish"))
      .toBe(command);
    expect(withRaisedNofileSoftLimit(command, "/opt/homebrew/bin/nu"))
      .toBe(command);
    expect(withRaisedNofileSoftLimit(command, "/bin/zsh"))
      .toContain("ulimit -Sn");
    const priorShell = process.env.SHELL;
    try {
      process.env.SHELL = "/opt/homebrew/bin/fish";
      expect(withRaisedNofileSoftLimit(command)).toBe(command);
    } finally {
      if (priorShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = priorShell;
    }
  });

  it("raises a managed seat shell from 256 without lowering a higher limit", () => {
    const probe = withRaisedNofileSoftLimit("ulimit -Sn", "/bin/sh");
    expect(runUnderSoftLimit(256, probe)).toBe(Math.min(65_536, hostHard));
    if (hostHard >= 131_072) {
      expect(runUnderSoftLimit(131_072, probe)).toBe(131_072);
    }
  });

  it("execs a daemon child with the raised limit and respects a lower hard limit", () => {
    const launch = nofileExecSpec("/bin/sh", ["-c", "ulimit -Sn"]);
    const result = spawnSync("/bin/sh", [
      "-c", 'ulimit -Sn 256; ulimit -Hn 4096; exec "$@"',
      "cmuxlayer-nofile-test", launch.command, ...launch.args,
    ], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("4096");
  });
});
