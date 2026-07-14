import type { CreateServerOptions } from "../../src/server.js";

export const TEST_SURFACE_OBSERVER_OWNER =
  "cmux:/tmp/cmuxlayer-test-observer.sock";

type StandaloneServerOptions = Omit<CreateServerOptions, "context">;

/**
 * Synthetic cmux clients and refs must declare their synthetic owner instead
 * of borrowing CMUX_SOCKET_PATH from the developer's ambient shell.
 */
export function withTestSurfaceObserver<T extends StandaloneServerOptions>(
  opts: T,
): T & StandaloneServerOptions {
  return {
    ...opts,
    surfaceObserverOwnerIdProvider:
      opts.surfaceObserverOwnerIdProvider ??
      (() => TEST_SURFACE_OBSERVER_OWNER),
    surfaceObserverEpochProvider:
      opts.surfaceObserverEpochProvider ??
      (() => `${TEST_SURFACE_OBSERVER_OWNER}@test`),
  };
}
