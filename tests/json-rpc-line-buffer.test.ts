import { describe, expect, it, vi } from "vitest";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { JsonRpcLineBuffer } from "../src/json-rpc-line-buffer.js";

describe("JsonRpcLineBuffer", () => {
  it("reads a split large JSON-RPC frame without repeated Buffer.concat copies", () => {
    const payload = serializeMessage({
      jsonrpc: "2.0",
      id: 7,
      result: { text: "x".repeat(256 * 1024) },
    });
    const chunks = [
      Buffer.from(payload.slice(0, 17)),
      Buffer.from(payload.slice(17, 8192)),
      Buffer.from(payload.slice(8192)),
    ];
    const concatSpy = vi.spyOn(Buffer, "concat");
    const buffer = new JsonRpcLineBuffer();

    for (const chunk of chunks) {
      buffer.append(chunk);
    }

    expect(buffer.readFrame()?.toString("utf8")).toBe(payload);
    expect(buffer.readFrame()).toBeNull();
    expect(concatSpy).not.toHaveBeenCalled();

    concatSpy.mockRestore();
  });
});
