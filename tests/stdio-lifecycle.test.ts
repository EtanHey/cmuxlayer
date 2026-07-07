import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { bindStdioLifecycle } from "../src/stdio-lifecycle.js";

describe("bindStdioLifecycle", () => {
  it("runs shutdown when stdin ends or closes", () => {
    const stdin = new EventEmitter();
    const transport = new EventEmitter();
    const shutdown = vi.fn();

    bindStdioLifecycle({ stdin, transport, shutdown });

    stdin.emit("end");
    stdin.emit("close");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith("stdin:end");
  });

  it("runs shutdown when stdin errors", () => {
    const stdin = new EventEmitter();
    const transport = new EventEmitter();
    const shutdown = vi.fn();

    bindStdioLifecycle({ stdin, transport, shutdown });

    stdin.emit("error", new Error("pipe failed"));

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith("stdin:error");
  });

  it("runs shutdown when the stdio transport closes", () => {
    const stdin = new EventEmitter();
    const transport = new EventEmitter();
    const shutdown = vi.fn();

    bindStdioLifecycle({ stdin, transport, shutdown });

    transport.emit("close");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith("transport:close");
  });
});
