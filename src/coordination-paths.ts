import { isAbsolute, join } from "node:path";
import { agentDir, type InboxOpts } from "./inbox.js";

// AIDEV-NOTE (P11 / U10): engine-issued coordination paths. Before this, the
// DONE signal's producer (the worker, told a path in the lead's prose brief)
// and its consumer (assessHarvestability, which regex-SCORES code spans in that
// same prose) derived the contract from two independent readings of English.
// Nothing forced them to agree and nothing detected when they did not -- the
// S3 deadlock (retro 2026-08-17T20:40Z). Here the engine authors both strings
// ONCE, returns them in the spawn receipt, persists them on the record, and
// tells the worker the same values. Disagreement becomes impossible by
// construction rather than discouraged by prose.

/** Report file name inside the agent's channel dir. */
export const COORDINATION_REPORT_BASENAME = "report.md";

export interface CoordinationContract {
  /** Absolute, and OUTSIDE the worktree so it survives worktree removal (U10). */
  report_path: string;
  /** Engine-authored terminal marker the worker's final report line must equal. */
  done_marker: string;
}

export interface IssueCoordinationOpts extends InboxOpts {
  /** Optional absolute path chosen by the parent. Must be absolute. */
  reportPath?: string | null;
}

/**
 * Marker shaped to satisfy the ALREADY-SHIPPED verifier grammar in
 * agent-engine.ts extractDoneMarker: /^[A-Z0-9_:-]+$/ and /^DONE(?:[_:-]|$)/.
 * Keeping to that grammar is why the existing consumer needs no rewrite.
 */
export function coordinationDoneMarker(agentId: string): string {
  // AIDEV-NOTE: the FULL id, not just its suffix. A suffix-only marker collides
  // (`a-1` and `b-1` both yield DONE_1), which matters because the report_path
  // override lets a parent point several workers' reports at one shared collab
  // dir -- where a lead greps for markers and a collision is a wrong answer.
  const sanitized = agentId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `DONE_${sanitized.length > 0 ? sanitized : "AGENT"}`;
}

/**
 * Derive the contract from the agent id alone. Deliberately independent of the
 * launcher: it sits above launchMode, so a registry-optional / raw-CLI spawn
 * (#453) gets byte-identical fields by construction, not via a parallel code
 * path that could drift.
 */
export function issueCoordinationContract(
  agentId: string,
  opts?: IssueCoordinationOpts,
): CoordinationContract {
  const override = opts?.reportPath?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `report_path override must be absolute so producer and consumer resolve the same file: ${override}`,
      );
    }
    return { report_path: override, done_marker: coordinationDoneMarker(agentId) };
  }
  return {
    report_path: join(agentDir(agentId, opts), COORDINATION_REPORT_BASENAME),
    done_marker: coordinationDoneMarker(agentId),
  };
}

/**
 * Constraint 1 (Etan): at most two short lines, byte cost declared in the boot
 * receipt. Ships as ONE line, and that is deliberate -- the cap is a maximum.
 A newline here would make the injected boot prompt
 * multiline, and every extra character pushes the combined injection toward the
 * 500-char chunk threshold that splits the boot write. The shipped mailbox
 * contract solves the same problem the same way: one line, "; " separated.
 * Every prompt byte is instruction-layer cost (#424/#425), so this is as short
 * as it can be while still naming BOTH issued strings verbatim -- naming them
 * is the point, so they are what the budget is spent on.
 */
export function coordinationFooter(contract: CoordinationContract): string {
  return (
    `report to ${contract.report_path}; ` +
    `its final line must be exactly ${contract.done_marker}`
  );
}

/**
 * The boot injection budget. The engine types the mailbox contract and this
 * footer into the pane as one string; crossing SEND_INPUT_CHUNK_THRESHOLD (500)
 * splits that write into chunks and changes boot delivery for EVERY spawn. The
 * footer is sized to stay inside the budget rather than silently widening the
 * blast radius of a spawn -- see the guard test.
 */
export const BOOT_INJECTION_CHUNK_THRESHOLD = 500;

export function coordinationFooterBytes(contract: CoordinationContract): number {
  return Buffer.byteLength(coordinationFooter(contract), "utf8");
}

/**
 * Constraint 3: the default-detail completion field is a STATE, never a bare
 * boolean. Under a boolean, "done but no artifact" (the S3 deadlock a lead must
 * ACT on) and "still working" (wait) were both `false` -- three states collapsed
 * into one falsey value, the same hazard `paused` shipped with in v0.4.41 and
 * that v0.4.42 fixed by attaching provenance (types.ts pauseHonestyFields).
 *
 * Invariant: `artifact_missing` is reachable ONLY from state "done", so it is
 * an actionable deadlock signal on its own -- no cross-referencing required.
 */
export type ClosureState =
  | "verified"
  | "artifact_missing"
  | "pending"
  | "not_applicable";

export function resolveClosureState(input: {
  state: string;
  role?: string | null;
  contractIssued: boolean;
  closureArtifactVerified: boolean | null;
}): ClosureState {
  if (!input.contractIssued) return "not_applicable";
  if (input.role === "orchestrator") return "not_applicable";
  if (input.state !== "done") return "pending";
  return input.closureArtifactVerified === true
    ? "verified"
    : "artifact_missing";
}
