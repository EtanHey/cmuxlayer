import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
}));

vi.mock("../src/cmux-client-factory.js", () => ({
  createCmuxClient: vi.fn().mockResolvedValue({}),
}));
vi.mock("../src/server.js", () => ({
  createServer: vi.fn((options: Record<string, unknown>) => {
    captured.options = options;
    return { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  }),
}));
vi.mock("../src/stdio-lifecycle.js", () => ({ bindStdioLifecycle: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));
vi.mock("../src/heap-guard.js", () => ({
  ensureNodeMaxOldSpaceEnv: vi.fn(),
  installHeapGuard: vi.fn(),
}));
vi.mock("../src/fleet-sidebar.js", () => ({
  FleetSidebarPublisher: class {},
}));
vi.mock("../src/self-registration.js", () => ({
  makeSelfRegistrationSessionResolver: vi.fn(() => null),
}));

import { startInProcessRuntime } from "../src/entry.js";
import {
  defaultWatchRegistryPath,
  httpNotifyWatch,
} from "../src/watch-spec.js";

describe("in-process WatchSpec production wiring", () => {
  beforeEach(() => {
    captured.options = null;
  });

  it("passes the production watch registry and notifier into createServer", async () => {
    await startInProcessRuntime({ env: {} });

    expect(captured.options).toMatchObject({
      watchRegistryPath: defaultWatchRegistryPath(),
      watchNotify: httpNotifyWatch,
    });
  });
});
