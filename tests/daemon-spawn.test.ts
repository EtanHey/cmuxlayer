import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { capturedDaemonStderr, spawnDaemonProcess } from "../src/daemon-spawn.js";

describe("spawnDaemonProcess", () => {
  it("launches the daemon through the nofile wrapper", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-daemon-nofile-"));
    try {
      const proofPath = join(root, "nofile-soft.txt");
      const daemonScriptPath = join(root, "nofile-daemon.cjs");
      writeFileSync(daemonScriptPath,
        "const { execFileSync } = require('node:child_process');\n" +
        "const { writeFileSync } = require('node:fs');\n" +
        "writeFileSync(process.env.PROOF_PATH, execFileSync('/bin/sh', ['-c', 'ulimit -Sn'], { encoding: 'utf8' }));\n");
      const hardText = execFileSync("/bin/sh", ["-c", "ulimit -Hn"], {
        encoding: "utf8",
      }).trim();
      const hard = hardText === "unlimited" ? 65_536 : Number(hardText);
      const parentScript = [
        `import { spawnDaemonProcess } from ${JSON.stringify(new URL("../src/daemon-spawn.ts", import.meta.url).href)};`,
        "const child = await spawnDaemonProcess({",
        "  socketPath: process.env.TEST_SOCKET_PATH,",
        "  env: { PROOF_PATH: process.env.PROOF_PATH },",
        "  logger: { error() {} },",
        "  daemonScriptPath: process.env.DAEMON_SCRIPT_PATH,",
        "});",
        "if (child.spawnfile !== '/bin/sh') throw new Error('daemon bypassed nofile wrapper');",
        "const keepAlive = setInterval(() => {}, 1000);",
        "await new Promise((resolve) => child.once('close', resolve));",
        "clearInterval(keepAlive);",
      ].join("\n");
      const parent = spawnSync("/bin/sh", [
        "-c", 'ulimit -Sn 256; exec "$@"', "cmuxlayer-nofile-test",
        process.execPath, "--import", "tsx", "--input-type=module", "-e", parentScript,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_SOCKET_PATH: join(root, "daemon.sock"),
          DAEMON_SCRIPT_PATH: daemonScriptPath,
          PROOF_PATH: proofPath,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(parent.status, parent.stderr).toBe(0);
      const softText = readFileSync(proofPath, "utf8").trim();
      expect(softText === "unlimited" || Number(softText) >= Math.min(65_536, hard))
        .toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["test-pane-capability", "test-pane-capabilityt"])(
    "passes capability %s to a detached daemon without exposing it in diagnostics",
    async (token) => {
      const root = mkdtempSync(join(tmpdir(), "cmuxlayer-capability-daemon-"));
      const logger = { error: vi.fn() };
      const stderrSink = vi.fn();
      try {
        const daemonScriptPath = join(root, "capability-daemon.js");
        writeFileSync(daemonScriptPath,
          "require('node:fs').writeFileSync(process.env.PROOF_PATH, process.env.CMUX_SOCKET_CAPABILITY || 'missing');\n" +
          "process.stderr.write('capability=' + process.env.CMUX_SOCKET_CAPABILITY.slice(0, 8));\n" +
          "setTimeout(() => process.stderr.write(process.env.CMUX_SOCKET_CAPABILITY.slice(8)), 10);\n" +
          "setTimeout(() => process.stderr.write('\\n'), 20);\n");
        const child = await spawnDaemonProcess({
          socketPath: join(root, "daemon.sock"),
          env: { CMUX_SOCKET_CAPABILITY: token, PROOF_PATH: join(root, "proof") },
          logger,
          stderrSink,
          daemonScriptPath,
        });
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
        expect(readFileSync(join(root, "proof"), "utf8")).toBe(token);
        expect(capturedDaemonStderr(child)).not.toContain(token);
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(token);
        expect(JSON.stringify(stderrSink.mock.calls)).not.toContain(token);
        expect(stderrSink.mock.calls.map(([chunk]) => chunk).join(""))
          .toContain("capability=[REDACTED]");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("redacts a token longer than the capture limit before bounding stderr diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-long-capability-daemon-"));
    const token = `v${"A".repeat(8497)}SUF`;
    const stderrSink = vi.fn();
    try {
      const daemonScriptPath = join(root, "long-capability-daemon.js");
      writeFileSync(daemonScriptPath,
        "process.stderr.write('capability=' + process.env.CMUX_SOCKET_CAPABILITY.slice(0, 8200));\n" +
        "setTimeout(() => process.stderr.write(process.env.CMUX_SOCKET_CAPABILITY.slice(8200)), 10);\n");
      const child = await spawnDaemonProcess({
        socketPath: join(root, "daemon.sock"),
        env: { CMUX_SOCKET_CAPABILITY: token },
        logger: { error: vi.fn() },
        stderrSink,
        daemonScriptPath,
      });
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect(capturedDaemonStderr(child)).toContain("capability=[REDACTED]");
      expect(capturedDaemonStderr(child)).not.toContain("SUF");
      expect(stderrSink.mock.calls.map(([chunk]) => chunk).join(""))
        .toContain("capability=[REDACTED]");
      expect(stderrSink.mock.calls.map(([chunk]) => chunk).join(""))
        .not.toContain("SUF");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("records the detached daemon pid before returning when a receipt is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-daemon-receipt-"));
    const receiptPath = join(root, "daemon-pids.txt");
    let child: Awaited<ReturnType<typeof spawnDaemonProcess>> | undefined;
    try {
      const daemonScriptPath = join(root, "waiting-daemon.js");
      writeFileSync(daemonScriptPath, "setTimeout(() => {}, 60_000);\n");
      child = await spawnDaemonProcess({
        socketPath: join(root, "daemon.sock"),
        env: { CMUXLAYER_DAEMON_PID_RECEIPT: receiptPath },
        logger: { error: vi.fn() },
        daemonScriptPath,
      });

      expect(readFileSync(receiptPath, "utf8")).toBe(`${child.pid}\n`);
    } finally {
      child?.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("logs the exit status when a spawned daemon dies", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-daemon-spawn-"));
    const logger = { error: vi.fn() };
    try {
      const daemonScriptPath = join(root, "exiting-daemon.js");
      writeFileSync(daemonScriptPath, "process.exit(7);\n");
      const child = await spawnDaemonProcess({
        socketPath: join(root, "daemon.sock"),
        env: {},
        logger,
        daemonScriptPath,
      });
      await new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /spawned daemon exited \(pid=\d+, code=7, signal=none\)/,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
