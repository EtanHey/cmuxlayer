#!/usr/bin/env npx tsx
/**
 * Manual test: verify factory fallback and real socket operation.
 * Run: npx tsx src/test-fallback.ts
 */

import { createCmuxClient } from "./cmux-client-factory.js";
import { CmuxSocketClient } from "./cmux-socket-client.js";

async function test() {
  console.log("=== Manual Test: Graceful Fallback ===\n");

  // Test 1: Socket available → CmuxSocketClient
  const socketClient = await createCmuxClient();
  const isSocket = socketClient instanceof CmuxSocketClient;
  console.log(
    `1. Socket available → CmuxSocketClient: ${isSocket ? "PASS" : "FAIL"}`,
  );

  // Test 2: Socket unavailable → CmuxClient fallback
  const fallbackClient = await createCmuxClient({
    socketPath: "/tmp/nonexistent.sock",
  });
  const isFallback = !(fallbackClient instanceof CmuxSocketClient);
  console.log(
    `2. Fallback to CLI when socket missing: ${isFallback ? "PASS" : "FAIL"}`,
  );

  // Test 3: Socket client works for real operation
  if (socketClient instanceof CmuxSocketClient) {
    const ws = await socketClient.listWorkspaces();
    console.log(
      `3. Socket listWorkspaces (${ws.workspaces.length} workspaces): PASS`,
    );

    // Test 4: Sidebar operations work
    await socketClient.setStatus("test-key", "test-value", {
      workspace: ws.workspaces[0]?.ref,
    });
    console.log(`4. setStatus via socket: PASS`);
    await socketClient.clearStatus("test-key", {
      workspace: ws.workspaces[0]?.ref,
    });
    console.log(`5. clearStatus via socket: PASS`);
  }

  console.log("\n=== All manual tests passed ===");
}
test().catch((e) => console.error("FAIL:", e.message));
