import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDaemonSocketPath } from "../src/daemon-socket-path.js";

const stateSocket = (filename: string): string =>
  join(homedir(), ".local", "state", "cmux", filename);

describe("defaultDaemonSocketPath", () => {
  it.each([
    ["unset", {}],
    ["production bundle", { CMUX_BUNDLE_ID: "com.cmuxterm.app" }],
    ["production upstream", { CMUX_SOCKET_PATH: "/tmp/cmux-501.sock" }],
    [
      "production upstream pinned from Nightly",
      {
        CMUX_BUNDLE_ID: "com.cmuxterm.app.nightly",
        CMUX_SOCKET_PATH: "/tmp/cmux-501.sock",
      },
    ],
  ])("keeps the legacy production socket for %s", (_label, env) => {
    expect(defaultDaemonSocketPath(env)).toBe(
      stateSocket("cmuxlayer-stated.sock"),
    );
  });

  it.each([
    ["Nightly bundle", { CMUX_BUNDLE_ID: "com.cmuxterm.app.nightly" }],
    [
      "Nightly upstream pinned from production",
      {
        CMUX_BUNDLE_ID: "com.cmuxterm.app",
        CMUX_SOCKET_PATH: "/tmp/cmux-nightly.sock",
      },
    ],
  ])("uses a separate socket for %s", (_label, env) => {
    expect(defaultDaemonSocketPath(env)).toBe(
      stateSocket("cmuxlayer-stated-nightly.sock"),
    );
  });

  it("lets the explicit daemon socket override win", () => {
    expect(
      defaultDaemonSocketPath({
        CMUX_BUNDLE_ID: "com.cmuxterm.app.nightly",
        CMUX_SOCKET_PATH: "/tmp/cmux-nightly.sock",
        CMUXLAYER_DAEMON_SOCKET: "/custom/cmuxlayer.sock",
      }),
    ).toBe("/custom/cmuxlayer.sock");
  });
});
