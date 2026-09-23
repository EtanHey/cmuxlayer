import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateSocketPathsForOpts } from "../src/cmux-socket-probe.js";
import {
  cmuxSocketPathCandidates,
  nightlySocketPathCandidates,
} from "../src/cmux-socket-path.js";

afterEach(() => vi.unstubAllEnvs());

describe("cmux-socket-probe", () => {
  it("honors an explicit socketPath pin in candidate order", () => {
    expect(
      candidateSocketPathsForOpts({
        socketPath: "/tmp/pinned.sock",
        socketStateDir: "/tmp/state",
      }),
    ).toEqual(["/tmp/pinned.sock"]);
  });

  it.each([{}, { CMUX_SOCKET_PATH: "" }])(
    "does not inherit ambient socket path with injected env %j",
    (env) => {
      vi.stubEnv("CMUX_SOCKET_PATH", "/tmp/reg1d-ambient.sock");
      const stateDir = "/tmp/reg1d-socket-state";
      expect(candidateSocketPathsForOpts({ env, socketStateDir: stateDir })).toEqual(
        cmuxSocketPathCandidates({ env, stateDir }),
      );
      expect(candidateSocketPathsForOpts({ env, socketStateDir: stateDir })).not.toContain(
        "/tmp/reg1d-ambient.sock",
      );
    },
  );

  it("uses ambient socket path without injected env", () => {
    vi.stubEnv("CMUX_SOCKET_PATH", "/tmp/reg1d-ambient.sock");
    expect(candidateSocketPathsForOpts()).toEqual(["/tmp/reg1d-ambient.sock"]);
  });

  it.each([{}, { CMUX_BUNDLE_ID: "" }])(
    "does not inherit ambient nightly bundle with injected env %j",
    (env) => {
      vi.stubEnv("CMUX_SOCKET_PATH", "");
      vi.stubEnv("CMUX_BUNDLE_ID", "com.cmuxterm.app.nightly");
      const stateDir = "/tmp/reg1d-bundle-state";
      expect(candidateSocketPathsForOpts({ env, socketStateDir: stateDir })).toEqual(
        cmuxSocketPathCandidates({ env, stateDir }),
      );
    },
  );

  it("uses ambient nightly bundle without injected env", () => {
    vi.stubEnv("CMUX_SOCKET_PATH", "");
    vi.stubEnv("CMUX_BUNDLE_ID", "com.cmuxterm.app.nightly");
    const stateDir = "/tmp/reg1d-bundle-state";
    expect(candidateSocketPathsForOpts({ socketStateDir: stateDir })).toEqual(
      nightlySocketPathCandidates({ stateDir }),
    );
  });
});
