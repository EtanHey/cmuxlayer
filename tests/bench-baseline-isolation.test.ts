import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stopBaselineClientsBeforeDaemon } from "../scripts/bench-daemon.mjs";

const source = readFileSync(join(process.cwd(), "scripts/bench-daemon.mjs"), "utf8");

describe("benchmark baseline isolation", () => {
  it("stops the in-process baseline before starting the daemon phase", () => {
    const rssSample = source.indexOf("const baselineRssMb = await totalRssMb(");
    const stopBaseline = source.indexOf("await stopBaselineClientsBeforeDaemon(baselineClients);");
    const daemonStart = source.indexOf("daemon = spawn(process.execPath, [distDaemon]");

    expect(rssSample).toBeGreaterThan(-1);
    expect(stopBaseline).toBeGreaterThan(rssSample);
    expect(daemonStart).toBeGreaterThan(stopBaseline);
  });

  it("waits for every baseline client to exit and rejects a survivor", async () => {
    const clients = Array.from({ length: 8 }, () => ({
      alive: true,
      async close() {
        await Promise.resolve();
        this.alive = false;
      },
    }));
    await stopBaselineClientsBeforeDaemon(clients);
    expect(clients.every((client) => !client.alive)).toBe(true);

    await expect(stopBaselineClientsBeforeDaemon([{
      alive: true,
      async close() {},
    }])).rejects.toThrow("baseline client survived");
  });
});
