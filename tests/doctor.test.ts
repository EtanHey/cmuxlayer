import { describe, expect, it } from "vitest";
import {
  runDoctor,
  renderDoctorText,
  renderDoctorJson,
  type BrewRunner,
  type DoctorReport,
} from "../src/doctor.js";

/**
 * A brew stub: returns canned results keyed on the first meaningful arg.
 * `found: false` simulates "brew not found" (ENOENT).
 */
function makeBrew(opts: {
  found?: boolean;
  tapList?: string;
  infoOk?: boolean;
}): BrewRunner {
  const { found = true, tapList = "", infoOk = true } = opts;
  return async (args: string[]) => {
    if (!found) {
      return { ok: false, stdout: "", stderr: "", notFound: true };
    }
    if (args[0] === "tap") {
      return { ok: true, stdout: tapList, stderr: "" };
    }
    if (args[0] === "info") {
      return infoOk
        ? {
            ok: true,
            stdout: "etanhey/layers/cmuxlayer: stable 0.3.0",
            stderr: "",
          }
        : { ok: false, stdout: "", stderr: "Error: No available formula" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

describe("runDoctor — report shape", () => {
  it("reports the version when it resolves", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.version.ok).toBe(true);
    expect(report.version.value).toBe("0.3.0");
  });

  it("flags an unknown version as not-ok", async () => {
    const report = await runDoctor({
      version: "unknown",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.version.ok).toBe(false);
  });

  it("marks §1 account-rename self-heal as not-applicable (stdio MCP, no cask)", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.caskSelfHeal.applicable).toBe(false);
    expect(report.caskSelfHeal.note).toMatch(/not-applicable/i);
    expect(report.caskSelfHeal.note).toMatch(/stdio MCP/i);
    expect(report.caskSelfHeal.note).toMatch(/no cask/i);
  });

  it("marks §5 daemon integrity as not-applicable (stdio MCP, no daemon)", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.daemon.applicable).toBe(false);
    expect(report.daemon.note).toMatch(/not-applicable/i);
    expect(report.daemon.note).toMatch(/stdio MCP/i);
    expect(report.daemon.note).toMatch(/no daemon/i);
  });

  it("reports the tap as present + formula resolvable when brew lists it", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({
        tapList: "homebrew/core\netanhey/layers\nfoo/bar\n",
        infoOk: true,
      }),
    });
    expect(report.tap.tapPresent).toBe(true);
    expect(report.tap.formulaResolves).toBe(true);
    expect(report.tap.note).toMatch(/CASKS need .*brew trust etanhey\/layers/i);
    expect(report.tap.note).toMatch(/formula, not gated/i);
  });

  it("reports the tap as absent when brew does not list it", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ tapList: "homebrew/core\n", infoOk: false }),
    });
    expect(report.tap.tapPresent).toBe(false);
  });

  it("degrades gracefully (does not throw / does not fail hard) when brew is not found", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ found: false }),
    });
    expect(report.tap.brewAvailable).toBe(false);
    expect(report.tap.note).toMatch(/brew not found/i);
    // brew unavailability must NOT make the doctor unhealthy.
    expect(report.healthy).toBe(true);
  });

  it("reports CMUX_SOCKET_PATH when set", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: { CMUX_SOCKET_PATH: "/tmp/cmux-501.sock" },
      brew: makeBrew({}),
    });
    expect(report.socketPath.set).toBe(true);
    expect(report.socketPath.value).toBe("/tmp/cmux-501.sock");
  });

  it("reports CMUX_SOCKET_PATH as unset (auto-discover) when absent", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({}),
    });
    expect(report.socketPath.set).toBe(false);
    expect(report.socketPath.note).toMatch(/unset \(auto-discover\)/i);
  });

  it("is healthy on a normal machine (version resolves)", async () => {
    const report = await runDoctor({
      version: "0.3.0",
      env: {},
      brew: makeBrew({ tapList: "etanhey/layers\n" }),
    });
    expect(report.healthy).toBe(true);
  });
});

describe("renderDoctorText", () => {
  function baseReport(): DoctorReport {
    return {
      healthy: true,
      version: { ok: true, value: "0.3.0" },
      caskSelfHeal: {
        applicable: false,
        note: "not-applicable: stdio MCP, no cask (§1 account-rename self-heal)",
      },
      daemon: {
        applicable: false,
        note: "not-applicable: stdio MCP, no daemon (§5 daemon integrity)",
      },
      tap: {
        brewAvailable: true,
        tapPresent: true,
        formulaResolves: true,
        note: "tap CASKS need `brew trust etanhey/layers`; cmuxlayer is a formula, not gated",
      },
      socketPath: { set: false, value: null, note: "unset (auto-discover)" },
    };
  }

  it("prints the version", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toContain("0.3.0");
  });

  it("prints the §1 not-applicable line explicitly (no silent no-op)", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/not-applicable: stdio MCP, no cask/i);
  });

  it("prints the §5 not-applicable line explicitly", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/not-applicable: stdio MCP, no daemon/i);
  });

  it("prints the tap status and the trust note for casks", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/brew trust etanhey\/layers/i);
    expect(text).toMatch(/formula, not gated/i);
  });

  it("prints the CMUX_SOCKET_PATH status", () => {
    const text = renderDoctorText(baseReport());
    expect(text).toMatch(/CMUX_SOCKET_PATH/);
    expect(text).toMatch(/unset \(auto-discover\)/i);
  });
});

describe("renderDoctorJson", () => {
  it("emits parseable JSON with the report fields", () => {
    const report: DoctorReport = {
      healthy: true,
      version: { ok: true, value: "0.3.0" },
      caskSelfHeal: {
        applicable: false,
        note: "not-applicable: stdio MCP, no cask",
      },
      daemon: {
        applicable: false,
        note: "not-applicable: stdio MCP, no daemon",
      },
      tap: {
        brewAvailable: true,
        tapPresent: true,
        formulaResolves: true,
        note: "ok",
      },
      socketPath: { set: true, value: "/tmp/x.sock", note: "set" },
    };
    const json = renderDoctorJson(report);
    const parsed = JSON.parse(json) as DoctorReport;
    expect(parsed.healthy).toBe(true);
    expect(parsed.version.value).toBe("0.3.0");
    expect(parsed.caskSelfHeal.applicable).toBe(false);
    expect(parsed.daemon.applicable).toBe(false);
    expect(parsed.tap.tapPresent).toBe(true);
    expect(parsed.socketPath.set).toBe(true);
    expect(parsed.socketPath.value).toBe("/tmp/x.sock");
  });
});
