import { describe, expect, it } from "vitest";
import { candidateSocketPathsForOpts } from "../src/cmux-socket-probe.js";

describe("cmux-socket-probe", () => {
  it("honors an explicit socketPath pin in candidate order", () => {
    expect(
      candidateSocketPathsForOpts({
        socketPath: "/tmp/pinned.sock",
        socketStateDir: "/tmp/state",
      }),
    ).toEqual(["/tmp/pinned.sock"]);
  });
});
