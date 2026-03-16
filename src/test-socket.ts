#!/usr/bin/env npx tsx
/**
 * Quick test: can we talk to cmux via socket directly?
 * Run: npx tsx src/test-socket.ts
 */

import * as net from "node:net";
import * as crypto from "node:crypto";

const SOCKET_PATH = process.env.CMUX_SOCKET_PATH ?? "/tmp/cmux.sock";

function sendV2(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{
  ok: boolean;
  result?: unknown;
  error?: unknown;
  latencyMs: number;
}> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const request = JSON.stringify({ id, method, params }) + "\n";
    const start = performance.now();

    const socket = net.createConnection({ path: SOCKET_PATH }, () => {
      socket.write(request);
    });

    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timeout waiting for ${method}`));
    }, 5000);

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        clearTimeout(timeout);
        socket.destroy();
        try {
          const parsed = JSON.parse(line);
          resolve({
            ...parsed,
            latencyMs: performance.now() - start,
          });
        } catch {
          resolve({
            ok: false,
            error: `Non-JSON response: ${line}`,
            latencyMs: performance.now() - start,
          });
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function benchmark(
  label: string,
  fn: () => Promise<unknown>,
  iterations: number = 50,
): Promise<void> {
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    latencies.push(performance.now() - start);
  }
  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const opsPerSec = Math.round(1000 / avg);
  console.log(
    `  ${label}: avg=${avg.toFixed(1)}ms p50=${p50?.toFixed(1)}ms p99=${p99?.toFixed(1)}ms ops/s=${opsPerSec}`,
  );
}

async function main() {
  console.log(`\n=== cmux Socket Client Test ===`);
  console.log(`Socket: ${SOCKET_PATH}\n`);

  // Test 1: Ping
  console.log("1. Testing system.ping via socket...");
  try {
    const ping = await sendV2("system.ping");
    console.log(
      `   ✓ Ping: ok=${ping.ok} latency=${ping.latencyMs.toFixed(1)}ms`,
    );
    console.log(`   Result:`, JSON.stringify(ping.result));
  } catch (e) {
    console.log(`   ✗ Ping failed:`, (e as Error).message);
    console.log("\n   Cannot connect to cmux socket. Is cmux running?");
    process.exit(1);
  }

  // Test 2: List workspaces
  console.log("\n2. Testing workspace.list via socket...");
  try {
    const ws = await sendV2("workspace.list");
    console.log(
      `   ✓ workspace.list: ok=${ws.ok} latency=${ws.latencyMs.toFixed(1)}ms`,
    );
    const workspaces = (ws.result as Record<string, unknown>)?.workspaces;
    if (Array.isArray(workspaces)) {
      console.log(`   Found ${workspaces.length} workspaces`);
      for (const w of workspaces.slice(0, 5)) {
        const ws = w as Record<string, unknown>;
        console.log(`     - ${ws.ref}: ${ws.title}`);
      }
    }
  } catch (e) {
    console.log(`   ✗ Failed:`, (e as Error).message);
  }

  // Test 3: System capabilities
  console.log("\n3. Testing system.capabilities...");
  try {
    const caps = await sendV2("system.capabilities");
    console.log(
      `   ✓ capabilities: ok=${caps.ok} latency=${caps.latencyMs.toFixed(1)}ms`,
    );
  } catch (e) {
    console.log(`   ✗ Failed:`, (e as Error).message);
  }

  // Test 4: System tree
  console.log("\n4. Testing system.tree...");
  try {
    const tree = await sendV2("system.tree");
    console.log(
      `   ✓ tree: ok=${tree.ok} latency=${tree.latencyMs.toFixed(1)}ms`,
    );
  } catch (e) {
    console.log(`   ✗ Failed:`, (e as Error).message);
  }

  // Benchmark: Socket vs CLI
  console.log("\n=== Benchmark: Socket Direct (50 iterations each) ===\n");

  await benchmark("system.ping", () => sendV2("system.ping"));
  await benchmark("workspace.list", () => sendV2("workspace.list"));

  // CLI benchmark for comparison
  console.log("\n=== Benchmark: CLI Shell-out (50 iterations each) ===\n");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  await benchmark("cmux --json list-workspaces", async () => {
    await execFileAsync("cmux", ["--json", "list-workspaces"]);
  });

  await benchmark("cmux --json ping", async () => {
    try {
      await execFileAsync("cmux", ["--json", "ping"]);
    } catch {
      // ping might not be a valid CLI command, that's fine for benchmarking
    }
  });

  console.log("\n=== Done ===\n");
}

main().catch(console.error);
