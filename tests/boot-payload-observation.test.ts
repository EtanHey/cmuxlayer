import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerContext } from "../src/server.js";
import { createDeliveryEngine } from "../src/delivery/engine.js";
import { createSuccessfulDispatchRpcMethod } from "../src/mcp/registration.js";
import { withTransportRetryTracking } from "../src/transport-retry-context.js";

const payload = "Read and follow /tmp/p0fixture/task.md";
const UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const screen = (draft = "") => `Claude Code\nWhat can I help you with?\n❯ ${draft}\n  ⎇ main | 🔧 9`;
let directory: string;
const contexts: ReturnType<typeof createServerContext>[] = [];

function setup(options: { paintAfter?: number; timeout?: number; edited?: string; readError?: boolean; lateRead?: boolean; changeRoute?: boolean; changeUuid?: boolean; editAtReturn?: boolean;
  accept?: "late" | "pending"; finalRead?: "expired" | "error" | "foreign-expired"; recoveryError?: "read" | "surface-gone" | "uuid"; managed?: boolean } = {}) {
  const state = { typedAt: null as number | null, text: "", returns: 0, writes: 0, afterTypeReads: 0, completeReads: 0, routeChanged: false, uuidChanged: false,
    accepted: false, firstPostReturnRead: null as number | null, recoveryArmed: false };
  const client = {
    readScreen: vi.fn(async () => {
      if (state.returns) {
        if (options.recoveryError === "read" && state.recoveryArmed) throw Error("post-Return transport read failure");
        if (options.recoveryError === "surface-gone" && state.recoveryArmed) throw Error("surface_not_found: surface:2");
        if (state.accepted) return { text: `Claude Code\n⏺ ${state.text}\n✻ Working… (esc to interrupt)\n❯ ` };
        state.firstPostReturnRead ??= Date.now();
        if (Date.now() - state.firstPostReturnRead >= 250) state.recoveryArmed = true;
        return { text: screen(state.text) };
      }
      if (state.typedAt !== null) {
        state.afterTypeReads++;
        if (options.readError) throw Error("recorded transport read failure");
        if (options.lateRead) await new Promise(resolve => setTimeout(resolve, 2000));
        if (Date.now() - state.typedAt >= (options.paintAfter ?? 500)) {
          state.completeReads++;
          if (state.completeReads === 3 && options.finalRead) {
            if (options.finalRead === "error") throw Error("final pre-Return read failure");
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (options.finalRead === "foreign-expired") return { text: screen("another user's draft") };
          }
          return { text: screen(options.edited ?? state.text) };
        }
      }
      return { text: screen() };
    }),
    send: vi.fn(async (_surface: string, text: string) => { state.text = text; state.typedAt = Date.now(); state.writes++; state.routeChanged = Boolean(options.changeRoute); state.uuidChanged = Boolean(options.changeUuid); }),
    sendKey: vi.fn(async (_surface: string, key: string) => { if (key === "return") { state.returns++; state.accepted = !options.accept; } }),
    getTransportHealth: () => ({ transport: "socket", socket_path: "/tmp/p0fixture.sock", socket_path_state: "active", fallback_count: 0 }),
    currentObserverTransportEpoch: () => 0,
    currentSocketPath: () => "/tmp/p0fixture.sock",
  };
  const context = createServerContext({ client: client as any, stateDir: directory, inboxBaseDir: directory, skipAgentLifecycle: true, controlHealthIntervalMs: 0, seatRegistry: null });
  contexts.push(context);
  const caller = options.managed ? { agent_id: "spawning-caller" } as any : null;
  if (options.managed) context.stateMgr.writeState({ agent_id: "boot-child", surface_id: "surface:2", surface_uuid: UUID,
    workspace_id: "workspace:1", role: "worker", cli: "claude", state: "ready", repo: "cmuxlayer", model: "opus", version: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), boot_instance_id: "boot-instance", boot_prompt_pending: true, prompt_delivered: false } as any);
  const delivery = createDeliveryEngine({ context, client: context.client, inboxOpts: {}, resolveCurrentCallerAgent: () => caller,
    assertSurfaceMutationAllowed: async () => {
      if (options.editAtReturn && state.completeReads >= 2) state.text += " edited";
      if (options.accept === "late" && state.recoveryArmed && state.returns === 1) state.accepted = true;
    },
    successfulDispatchRpcMethod: createSuccessfulDispatchRpcMethod(context.client), lifecycleSeatManifestPublisher: async () => {} });
  const run = () => withTransportRetryTracking(() => delivery.deliverBootPrompt({ surface: "surface:2", workspace: "workspace:1", stableSurfaceIdentity: UUID,
    cli: "claude", prompt: payload, delivery_id: "original-boot-delivery", timeout_ms: options.timeout ?? 3000,
    resolveRoute: async () => ({ surface: state.routeChanged ? "surface:other" : "surface:2", workspace: "workspace:1" }),
    assertStableSurfaceIdentity: async () => { if (state.uuidChanged || (options.recoveryError === "uuid" && state.recoveryArmed)) throw Error("surface UUID changed"); },
  }));
  return { state, run, client, context };
}

async function settle(run: () => Promise<unknown>) {
  const result = run().then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  return result;
}

describe("Claude boot payload observation deadline", () => {
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cmuxlayer-boot-observe-")); });
  afterEach(() => { for (const c of contexts.splice(0)) c.dispose(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
  it("submits once when repaint occurs after the old three-read window", async () => {
    const h = setup(); vi.useFakeTimers();
    const r = await settle(h.run);
    expect(r).not.toHaveProperty("error");
    expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(1);
    expect(r.value).toMatchObject({ submit_dispatched: true, submit_verified: true });
  });
  it("never returns when the remaining deadline expires without a full repaint", async () => {
    const h = setup({ paintAfter: 10_000, timeout: 600 }); vi.useFakeTimers();
    await settle(h.run); expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(0);
  });
  it("rejects a read that completes beyond the remaining deadline", async () => {
    const h = setup({ lateRead: true, timeout: 600 }); vi.useFakeTimers();
    await settle(h.run); expect(h.state.returns).toBe(0);
  });
  it("fails closed on transport read errors", async () => {
    const h = setup({ readError: true }); vi.useFakeTimers();
    await settle(h.run); expect(h.state.returns).toBe(0);
  });
  it.each([{ changeRoute: true }, { changeUuid: true }])("rejects changed route/UUID %j", async options => {
    const h = setup(options); vi.useFakeTimers();
    const r = await settle(h.run); expect(r).toHaveProperty("error");
    expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(0);
  });
  it("rechecks the exact draft after complete evidence, immediately before Return", async () => {
    const h = setup({ editAtReturn: true }); vi.useFakeTimers();
    const r = await settle(h.run); expect(r).toHaveProperty("error"); expect(h.state.returns).toBe(0);
  });
  it.each([`foreign ${payload}`, `${payload} edited`, "another user's draft"])("never submits edited/foreign draft %s", async edited => {
    const h = setup({ edited, paintAfter: 0, timeout: 800 }); vi.useFakeTimers();
    await settle(h.run); expect(h.state.returns).toBe(0);
  });
  it("verifies the first Return landing during the recovery delay with its original receipt", async () => {
    const h = setup({ paintAfter: 0, accept: "late", managed: true }); vi.useFakeTimers();
    const r = await settle(h.run);
    expect(r).not.toHaveProperty("error");
    expect(r.value).toMatchObject({ delivery_id: "original-boot-delivery", delivery_state: "submitted", typed: true, submit_dispatched: true, submit_verified: true, retry_count: 0 });
    expect(h.state.recoveryArmed).toBe(true); expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(1);
  });
  it("keeps a dispatched pending Return truthful after the boot observation deadline", async () => {
    const h = setup({ paintAfter: 0, accept: "pending", timeout: 450, managed: true }); vi.useFakeTimers();
    const r = await settle(h.run);
    expect(r).not.toHaveProperty("error");
    expect(r.value).toMatchObject({ delivery_id: "original-boot-delivery", delivery_state: "pending_verify", typed: true, submit_dispatched: true, submit_verified: null, retry_count: 1 });
    expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(2);
  });
  it("preserves the unsubmitted receipt and boot owner when only the final read exceeds the deadline", async () => {
    const h = setup({ paintAfter: 0, finalRead: "expired", timeout: 600, managed: true }); vi.useFakeTimers();
    const r = await settle(h.run);
    expect(r).not.toHaveProperty("error");
    expect(r.value).toMatchObject({ delivery_id: "original-boot-delivery", delivery_state: "pending_verify", typed: true, submit_dispatched: false, submit_verified: null, retry_count: 0 });
    expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(0);
    expect([...h.context.typedDraftOwners.values()]).toEqual([expect.objectContaining({ caller: "spawning-caller", text: payload, uuid: UUID, bootAgentId: "boot-child", bootInstanceId: "boot-instance", deliveryIds: ["original-boot-delivery"] })]);
  });
  it.each(["error", "foreign-expired"] as const)("fails closed for a final read with %s instead of calling it deadline-only expiry", async finalRead => {
    const h = setup({ paintAfter: 0, finalRead, timeout: 600, managed: true }); vi.useFakeTimers();
    const r = await settle(h.run);
    expect(r).toHaveProperty("error"); expect(r.error).toMatchObject({ typed: true }); expect(r.error?.submit_dispatched).not.toBe(true);
    expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(0);
  });
  it("keeps post-Return transport read uncertainty pending without another Return", async () => {
    const h = setup({ paintAfter: 0, accept: "pending", recoveryError: "read", managed: true }); vi.useFakeTimers();
    const r = await settle(h.run);
    expect(r).not.toHaveProperty("error");
    expect(r.value).toMatchObject({ delivery_id: "original-boot-delivery", delivery_state: "pending_verify", typed: true, submit_dispatched: true, submit_verified: null, retry_count: 0 });
    expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(1);
  });
  it.each(["surface-gone", "uuid"] as const)("preserves dispatched truth on post-Return %s errors", async recoveryError => {
    const h = setup({ paintAfter: 0, accept: "pending", recoveryError, managed: true }); vi.useFakeTimers();
    const r = await settle(h.run);
    expect(r).toHaveProperty("error"); expect(r.error).toMatchObject({ typed: true, submit_dispatched: true });
    expect(h.state.writes).toBe(1); expect(h.state.returns).toBe(1);
  });
});
