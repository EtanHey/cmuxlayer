import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CmuxClient } from "../src/cmux-client.js";
import { wrapCliWithSelfHeal } from "../src/cmux-transport-self-heal.js";
import { createServer } from "../src/server.js";

describe("interactive tool transport retry metadata", () => {
  afterEach(() => vi.useRealTimers());

  it("returns retry_count=1 after an errno-32 write retry succeeds", async () => {
    vi.useFakeTimers();
    const exec = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Broken pipe, errno 32"), {
          code: 1,
          stderr: "Failed to write to socket (Broken pipe, errno 32)",
        }),
      )
      .mockResolvedValue({ stdout: "{}", stderr: "" });
    const retryClient = wrapCliWithSelfHeal(
      new CmuxClient({ exec, bin: "cmux" }),
      {
        socketPath: "/tmp/retry-tool.sock",
        reprobeIntervalMs: 60_000,
        retryBaseMs: 100,
        retryCapMs: 400,
        retryAttempts: 3,
        random: () => 0,
      },
    );
    const server = createServer({
      client: retryClient as unknown as CmuxClient,
      skipAgentLifecycle: true,
    });
    const client = new Client({ name: "retry-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const call = client.callTool({
      name: "set_status",
      arguments: { key: "build", value: "retrying" },
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await call;

    expect(result.structuredContent).toMatchObject({
      ok: true,
      retry_count: 1,
    });
    expect(exec).toHaveBeenCalledTimes(2);
    retryClient.stop();
    await client.close();
    await server.close();
  });
});
