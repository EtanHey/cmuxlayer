#!/usr/bin/env node

import readline from "node:readline";
import { createCmuxClient } from "./cmux-client-factory.js";
import {
  CodexAppServerBridge,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./app-server-bridge.js";
import { CmuxAppServerRuntime } from "./app-server-runtime.js";

function writeJson(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main() {
  const client = await createCmuxClient();
  const runtime = new CmuxAppServerRuntime({ client });
  await runtime.initialize();

  const bridge = new CodexAppServerBridge({
    runtime,
    emitNotification: (notification: JsonRpcNotification) => writeJson(notification),
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const shutdown = () => {
    rl.close();
    runtime.dispose();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  rl.on("line", async (line) => {
    if (!line.trim()) {
      return;
    }

    try {
      const message = JSON.parse(line) as JsonRpcRequest;
      const response = await bridge.handleMessage(message);
      if (response) {
        writeJson(response);
      }
    } catch (error) {
      writeJson({
        id: 0,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  rl.on("close", () => {
    runtime.dispose();
  });
}

main().catch((error) => {
  console.error("[cmuxlayer-app-server] fatal", error);
  process.exit(1);
});
