import { describe, it, expect, vi } from "vitest";
import { AsyncSemaphore } from "../../src/secure/tool-wrapper.js";

describe("AsyncSemaphore", () => {
  it("acquire immediately when below max", async () => {
    const sem = new AsyncSemaphore(2);
    const r1 = await sem.acquire(1000);
    expect(typeof r1).toBe("function");
    r1();
  });

  it("blocks when max is reached and resumes after release", async () => {
    const sem = new AsyncSemaphore(1);
    const r1 = await sem.acquire(1000);

    let acquired = false;
    const p2 = sem.acquire(1000).then((release) => {
      acquired = true;
      release();
    });

    // p2 should still be pending
    expect(acquired).toBe(false);

    // Release first slot
    r1();

    await p2;
    expect(acquired).toBe(true);
  });

  it("times out when slot is never released", async () => {
    const sem = new AsyncSemaphore(1);
    const r1 = await sem.acquire(1000); // occupy the only slot

    await expect(sem.acquire(50)).rejects.toThrow(
      /Too many concurrent requests/,
    );

    r1(); // cleanup
  });

  it("FIFO order: waiters are served in queue order", async () => {
    const sem = new AsyncSemaphore(1);
    const order: number[] = [];

    const r1 = await sem.acquire(1000);

    const p2 = sem.acquire(1000).then((release) => {
      order.push(2);
      release();
    });
    const p3 = sem.acquire(1000).then((release) => {
      order.push(3);
      release();
    });

    r1(); // release → p2 should run first
    await p2;
    await p3;

    expect(order).toEqual([2, 3]);
  });

  it("removes timed-out waiter from queue so others can proceed", async () => {
    const sem = new AsyncSemaphore(1);
    const r1 = await sem.acquire(1000);

    // This will time out and leave the queue
    const pTimeout = sem.acquire(50).catch(() => "timeout");

    // Wait for the timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // This should succeed after the first slot is released
    const p2 = sem.acquire(1000).then((release) => {
      release();
      return "ok";
    });

    r1();

    const result = await p2;
    expect(result).toBe("ok");
    expect(await pTimeout).toBe("timeout");
  });

  it("handles multiple concurrent slots correctly", async () => {
    const sem = new AsyncSemaphore(3);

    const r1 = await sem.acquire(100);
    const r2 = await sem.acquire(100);
    const r3 = await sem.acquire(100);

    let acquired4 = false;
    const p4 = sem.acquire(50).then((release) => {
      acquired4 = true;
      release();
    });

    expect(acquired4).toBe(false);

    r1();
    await p4;
    expect(acquired4).toBe(true);

    r2();
    r3();
  });
});

describe("wrapTool concurrency integration", () => {
  it("returns error when semaphore limit is exceeded and times out", async () => {
    const { wrapTool } = await import("../../src/secure/tool-wrapper.js");
    const sem = new AsyncSemaphore(1);
    const slowHandler = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { content: [{ type: "text" as const, text: "done" }] };
    });

    const tool = wrapTool(
      {
        toolName: "test.tool",
        schema: {} as any,
        handler: slowHandler,
      },
      {
        policy: {
          project: { root: "/tmp", max_file_read_bytes: 1000, max_search_results: 10, deny: [] },
          tools: { allow: ["test.tool"], require_confirmation: [], deny: [] },
          limits: {
            max_output_lines: 500,
            max_screen_chars: 50000,
            max_request_body_bytes: 100000,
            tool_timeout_ms: 50,
            max_concurrent_requests: 1,
          },
        },
        auditLogger: {
          log: vi.fn(),
          logSync: vi.fn(),
          recent: vi.fn().mockResolvedValue([]),
          close: vi.fn().mockResolvedValue(undefined),
        },
        redactor: { redact: (s: string) => s, addPattern: vi.fn() },
        requestId: "req-1",
        mode: "test",
        semaphore: sem,
      },
      {} as any,
    );

    // First call occupies the slot
    const p1 = tool.handler({});

    // Second call should time out waiting for the slot
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("Too many concurrent requests");

    await p1; // let first call finish
  });
});
