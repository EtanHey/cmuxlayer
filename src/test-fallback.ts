#!/usr/bin/env npx tsx
/**
 * Manual test: verify factory fallback and real socket operation.
 * Run: npx tsx src/test-fallback.ts
 * Exits non-zero if any test fails.
 */

import { createCmuxClient } from "./cmux-client-factory.js";
import { getTransportHealth } from "./cmux-transport-self-heal.js";

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

  // Test 1: Socket available → socket transport
  const socketClient = await createCmuxClient();
  const socketHealth = getTransportHealth(socketClient);
  assert(
    "Socket available → socket transport",
    socketHealth?.mode === "socket" && socketHealth.degraded === false,
  );

  // Test 2: Socket unavailable → CLI fallback
  const fallbackClient = await createCmuxClient({
    socketPath: "/tmp/nonexistent.sock",
  });
  const fallbackHealth = getTransportHealth(fallbackClient);
  assert(
    "Fallback to CLI when socket missing",
    fallbackHealth?.mode === "cli" && fallbackHealth.degraded === true,
  );

  // Test 3-5: Socket client works for real operations
  if (socketHealth?.mode === "socket") {
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
