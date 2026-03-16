#!/usr/bin/env npx tsx
/**
 * Manual test: verify factory fallback and real socket operation.
 * Run: npx tsx src/test-fallback.ts
 * Exits non-zero if any test fails.
 */

import { createCmuxClient } from "./cmux-client-factory.js";
import { CmuxSocketClient } from "./cmux-socket-client.js";

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.error(`  FAIL: ${label}`);
    process.exitCode = 1;
  }
}

async function test() {
  console.log("=== Manual Test: Graceful Fallback ===\n");

  // Test 1: Socket available → CmuxSocketClient
  const socketClient = await createCmuxClient();
  assert(
    "Socket available → CmuxSocketClient",
    socketClient instanceof CmuxSocketClient,
  );

  // Test 2: Socket unavailable → CmuxClient fallback
  const fallbackClient = await createCmuxClient({
    socketPath: "/tmp/nonexistent.sock",
  });
  assert(
    "Fallback to CLI when socket missing",
    !(fallbackClient instanceof CmuxSocketClient),
  );

  // Test 3-5: Socket client works for real operations
  if (socketClient instanceof CmuxSocketClient) {
    const ws = await socketClient.listWorkspaces();
    assert(
      `Socket listWorkspaces (${ws.workspaces.length} workspaces)`,
      ws.workspaces.length > 0,
    );

    await socketClient.setStatus("test-key", "test-value", {
      workspace: ws.workspaces[0]?.ref,
    });
    assert("setStatus via socket", true);

    await socketClient.clearStatus("test-key", {
      workspace: ws.workspaces[0]?.ref,
    });
    assert("clearStatus via socket", true);
  }

  if (process.exitCode) {
    console.log("\n=== SOME TESTS FAILED ===");
  } else {
    console.log("\n=== All manual tests passed ===");
  }
}

test().catch((e) => {
  console.error("FATAL:", e.message);
  process.exitCode = 1;
});
