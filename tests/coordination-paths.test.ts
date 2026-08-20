import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  issueCoordinationContract,
  coordinationFooter,
  coordinationFooterBytes,
  resolveClosureState,
  COORDINATION_REPORT_BASENAME,
} from "../src/coordination-paths.js";

const TEST_DIR = join(tmpdir(), `cmuxlayer-p11-${process.pid}`);

describe("P11 coordination contract issuance", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("derives an absolute report path in the agent channel dir, outside any worktree", () => {
    const contract = issueCoordinationContract("cmuxlayerClaude-53fca1ae", {
      baseDir: TEST_DIR,
    });
    expect(contract.report_path).toBe(
      join(TEST_DIR, "cmuxlayerClaude-53fca1ae", COORDINATION_REPORT_BASENAME),
    );
    // U10: outside the worktree, so it survives worktree removal at harvest.
    expect(contract.report_path.includes(".worktrees")).toBe(false);
  });

  it("is deterministic for the same agent id", () => {
    const a = issueCoordinationContract("w-1", { baseDir: TEST_DIR });
    const b = issueCoordinationContract("w-1", { baseDir: TEST_DIR });
    expect(a).toEqual(b);
  });

  it("issues a marker the ALREADY-SHIPPED extractDoneMarker grammar accepts", () => {
    const { done_marker } = issueCoordinationContract(
      "cmuxlayerClaude-53fca1ae",
      { baseDir: TEST_DIR },
    );
    expect(done_marker).toBe("DONE_CMUXLAYERCLAUDE_53FCA1AE");
    // agent-engine.ts extractDoneMarker requires both of these.
    expect(/^[A-Z0-9_:-]+$/.test(done_marker)).toBe(true);
    expect(/^DONE(?:[_:-]|$)/.test(done_marker)).toBe(true);
  });

  it("sanitizes ids that would otherwise break the marker grammar", () => {
    const { done_marker } = issueCoordinationContract("weird id.v2", {
      baseDir: TEST_DIR,
    });
    expect(/^[A-Z0-9_:-]+$/.test(done_marker)).toBe(true);
    expect(/^DONE(?:[_:-]|$)/.test(done_marker)).toBe(true);
  });

  it("honors an explicit absolute parent report_path override", () => {
    const override = join(TEST_DIR, "collab", "worker-report.md");
    const contract = issueCoordinationContract("w-1", {
      baseDir: TEST_DIR,
      reportPath: override,
    });
    expect(contract.report_path).toBe(override);
    expect(contract.done_marker).toBe("DONE_W_1");
  });

  it("markers are unique per agent even when two ids share a suffix", () => {
    // A suffix-only marker would give both of these DONE_1 -- and the override
    // above lets both reports land in one shared collab dir.
    const a = issueCoordinationContract("alpha-1", { baseDir: TEST_DIR });
    const b = issueCoordinationContract("beta-1", { baseDir: TEST_DIR });
    expect(a.done_marker).not.toBe(b.done_marker);
  });

  it("rejects a relative override rather than silently resolving it", () => {
    expect(() =>
      issueCoordinationContract("w-1", {
        baseDir: TEST_DIR,
        reportPath: "reports/worker.md",
      }),
    ).toThrow(/absolute/i);
  });
});

describe("P11 boot footer (Constraint 1: <=2 short lines, bytes declared)", () => {
  const contract = {
    report_path: "/Users/x/.cmux/agents/w-1/report.md",
    done_marker: "DONE_W_1",
  };

  it("is ONE line -- a newline would flip boot delivery to the paste route", () => {
    expect(coordinationFooter(contract).split("\n")).toHaveLength(1);
    expect(coordinationFooter(contract)).not.toMatch(/[\r\n]/);
  });

  it("names the exact issued path and marker so producer and consumer cannot diverge", () => {
    const footer = coordinationFooter(contract);
    expect(footer).toContain(contract.report_path);
    expect(footer).toContain(contract.done_marker);
  });

  it("declares its own UTF-8 byte cost", () => {
    expect(coordinationFooterBytes(contract)).toBe(
      Buffer.byteLength(coordinationFooter(contract), "utf8"),
    );
  });

  it("stays cheap enough to ride a boot prompt (#424/#425 discipline)", () => {
    expect(coordinationFooterBytes(contract)).toBeLessThan(240);
  });
});

describe("P11 closure state (Constraint 3: no bare boolean at default detail)", () => {
  // T1b (#488): `observed` is a done that something actually SAW -- a done
  // marker on screen, a finished transcript. `unobserved` is the bare registry
  // flip #408 writes on live agents, which must never claim a deadlock.
  const issued = { contractIssued: true, doneEvidence: true };
  const unobserved = { contractIssued: true, doneEvidence: false };

  it("done + verified artifact => verified", () => {
    expect(
      resolveClosureState({
        ...issued,
        state: "done",
        closureArtifactVerified: true,
      }),
    ).toBe("verified");
  });

  it("S3 SIGNATURE: done + done evidence + no artifact => artifact_missing, NOT pending", () => {
    expect(
      resolveClosureState({
        ...issued,
        state: "done",
        closureArtifactVerified: false,
      }),
    ).toBe("artifact_missing");
  });

  it("T1b: done with NO done evidence => pending, never artifact_missing", () => {
    const closure = resolveClosureState({
      ...unobserved,
      state: "done",
      closureArtifactVerified: false,
    });
    expect(closure).toBe("pending");
    expect(closure).not.toBe("artifact_missing");
  });

  it("T1b: a verified artifact IS done evidence, so it still reads verified", () => {
    expect(
      resolveClosureState({
        ...unobserved,
        state: "done",
        closureArtifactVerified: true,
      }),
    ).toBe("verified");
  });

  it("still working => pending, and NEVER artifact_missing", () => {
    for (const state of ["ready", "working", "idle", "error"]) {
      const closure = resolveClosureState({
        ...issued,
        state,
        closureArtifactVerified: false,
      });
      expect(closure).toBe("pending");
      expect(closure).not.toBe("artifact_missing");
    }
  });

  it("the deadlock and the healthy-busy case are DISTINGUISHABLE (skillcreator's falsifier)", () => {
    const deadlocked = resolveClosureState({
      ...issued,
      state: "done",
      closureArtifactVerified: false,
    });
    const working = resolveClosureState({
      ...issued,
      state: "working",
      closureArtifactVerified: false,
    });
    // Under a bare boolean both of these were `false`. That was the bug.
    expect(deadlocked).not.toBe(working);
  });

  it("F1b: done WITHOUT done evidence => pending, never the artifact_missing alarm", () => {
    // #408 flips live records to `done` on its own. `artifact_missing` means
    // "route a reviewer NOW", so a record flip must not be able to fire it.
    expect(
      resolveClosureState({
        contractIssued: true,
        state: "done",
        closureArtifactVerified: false,
        doneEvidence: false,
      }),
    ).toBe("pending");
  });

  it("F1b: a verified artifact stands on its own, evidence channel or not", () => {
    expect(
      resolveClosureState({
        contractIssued: true,
        state: "done",
        closureArtifactVerified: true,
        doneEvidence: false,
      }),
    ).toBe("verified");
  });

  it("no contract issued => not_applicable, never a falsey negative", () => {
    expect(
      resolveClosureState({
        contractIssued: false,
        state: "done",
        closureArtifactVerified: null,
        doneEvidence: true,
      }),
    ).toBe("not_applicable");
  });

  it("orchestrators are not_applicable", () => {
    expect(
      resolveClosureState({
        ...issued,
        state: "done",
        role: "orchestrator",
        closureArtifactVerified: null,
      }),
    ).toBe("not_applicable");
  });
});
