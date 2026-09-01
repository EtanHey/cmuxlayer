import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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
 * A newline here would make the injected boot prompt
 * multiline, and every extra character pushes the combined injection toward the
 * 500-char chunk threshold that splits the boot write. The shipped mailbox
 * contract solves the same problem the same way: one line, "; " separated.
 * Every prompt byte is instruction-layer cost (#424/#425), so this is as short
 * as it can be while still naming BOTH issued strings verbatim -- naming them
 * is the point, so they are what the budget is spent on.
 *
 * P11b: the contract now reaches the worker through the spawn contract FILE,
 * not this inline footer. This stays as the canonical one-line rendering of the
 * two issued strings (and as the receipt's byte measure); the inline injection
 * it was sized for is only reachable via CMUXLAYER_BOOT_CONTRACT=inline, where
 * it is still NOT sent. Any receipt reporting this size MUST also report how
 * (or whether) the contract was delivered.
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

/**
 * Receipt provenance for the unsent footer. Reviewer finding 3: reporting
 * `coordination_footer_bytes` alone is the v0.4.41 `paused` hazard -- an
 * authoritative-looking number with no provenance, from which a lead concludes
 * the worker was told. It was not. v0.4.42 fixed `paused` by attaching coverage
 * plus a note naming the issue; this does the same.
 */
export const COORDINATION_FOOTER_NOT_DELIVERED =
  "not_wired: boot delivery fell back to the pre-P11b INLINE mailbox contract (CMUXLAYER_BOOT_CONTRACT=inline, or the contract file could not be written). Inline, the mailbox contract already uses ~479 of the 500-char boot injection budget, so the report contract cannot ride with it without moving every spawn onto the chunked paste path (#434/#438). The LEAD must relay report_path and done_marker to this worker.";

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
 * Invariant: `artifact_missing` is reachable ONLY from state "done" AND from
 * POSITIVE done evidence, so it is an actionable deadlock signal on its own --
 * no cross-referencing required.
 *
 * AIDEV-NOTE (T1b/#488): the second half of that invariant is the fix. A bare
 * registry flip to `done` (#408 does this within minutes, with nothing having
 * observed a done) used to be enough, so healthy mid-work children -- one of
 * them two minutes old -- rendered the "route a reviewer NOW" signal. Absence
 * of done evidence is `pending`, never a deadlock claim.
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
  /**
   * Something OBSERVED this agent finish: a done marker on screen
   * (`task_done_detected_at`), a harness transcript that ended, or a verified
   * report. Required -- not optional -- so every call site has to say which
   * evidence it has rather than inheriting the record's word for it.
   */
  doneEvidence: boolean;
}): ClosureState {
  if (!input.contractIssued) return "not_applicable";
  if (input.role === "orchestrator") return "not_applicable";
  if (input.state !== "done") return "pending";
  // A verified artifact IS positive done evidence, so it is checked first.
  if (input.closureArtifactVerified === true) return "verified";
  return input.doneEvidence ? "artifact_missing" : "pending";
}

// ---------------------------------------------------------------------------
// P11b: the boot prompt carries a POINTER, not the contract.
//
// The mailbox contract is ~479 characters of instructions riding the most
// incident-prone delivery path in this repo. At 500 characters
// (SEND_INPUT_CHUNK_THRESHOLD) boot delivery leaves the typed path for the
// chunked paste path (#434/#438), so ANY addition -- the #454 report contract
// included -- was unshippable. That is the fleet's own pointer-brief law
// (payload in a file, one line on the wire) being violated by the engine.
//
// So: the engine WRITES the contract to a file at spawn, and the boot prompt
// points at it. One extra read before the agent's first turn, and an agent
// that ignores the pointer never learns its contract -- but a contract file
// that was never read is OBSERVABLE, whereas a chunked boot prompt that never
// submitted is silent today. This trades a silent failure for a visible one;
// it does not eliminate failure.
// ---------------------------------------------------------------------------

/** Contract file name inside the agent's channel dir (next to inbox.jsonl). */
export const COORDINATION_CONTRACT_BASENAME = "contract.md";

/**
 * Absolute path of the spawn contract file. In the channel dir, NOT the
 * worktree, for the same reason report_path is (U10): it must survive worktree
 * removal, and the agent's channel dir is the one directory the engine already
 * guarantees exists for every managed agent.
 */
export function coordinationContractPath(
  agentId: string,
  opts?: InboxOpts,
): string {
  return join(agentDir(agentId, opts), COORDINATION_CONTRACT_BASENAME);
}

/** Mailbox half of the contract, as the boot prompt used to carry it inline. */
export interface MailboxContractFields {
  monitor_command: string;
  cursor_update_command: string;
  cursor_update_env: string;
}

export interface BootContractFileInput {
  agentId: string;
  mailbox: MailboxContractFields;
  /** #454's issued contract. Omitted only where the spawn path issues none. */
  coordination?: CoordinationContract | null;
}

/**
 * The file's body. Every string here is ENGINE-AUTHORED and identical to what
 * the receipt reports -- the P11 invariant. Prose is kept minimal because the
 * agent pays for it in context, but unlike the boot prompt this budget is not
 * bounded by a keystroke threshold.
 */
export function renderBootContractFile(input: BootContractFileInput): string {
  const lines = [
    `# cmuxlayer contract for ${input.agentId}`,
    "",
    "Engine-issued at spawn. Do not re-derive these strings; use them verbatim.",
    "",
    "## Mailbox",
    "",
    // AIDEV-NOTE (F5 / ledger #24): `tail -n0 -F` BLOCKS. Run in the
    // foreground it is a self-deadlock -- the ledger recorded it happening
    // twice to the same reviewer. Inline, there was no budget to qualify it;
    // in the file there is, and the file is now the engine's own words under a
    // pointer that says "Read and follow", which reads MORE imperative than
    // the old "monitor with", not less. So the qualifier goes here, where it
    // costs zero wire bytes.
    //
    // Deliberately qualified HERE and not in recommendedMonitorCommand: that
    // function has other callers (receipts, nudges, tool descriptions) whose
    // consumers expect the bare command, and changing monitor semantics for
    // all of them inside a boot-delivery PR is the scope creep this lane is
    // supposed to model against. Those callers are the F5 follow-up (#461).
    // The canonical command stays a verbatim substring of the line below, so a
    // consumer matching on it still matches.
    "Run this in the BACKGROUND -- it blocks, and holding a turn open on it is a",
    "self-deadlock (ledger #24). Detach it, then return:",
    "",
    `    ${input.mailbox.monitor_command} &`,
    "",
    `After each handled message run: ${input.mailbox.cursor_update_env}=<handled-message-id> ${input.mailbox.cursor_update_command}`,
    "",
  ];
  if (input.coordination) {
    lines.push(
      "## Report",
      "",
      `Write your report to: ${input.coordination.report_path}`,
      `Its final line must be exactly: ${input.coordination.done_marker}`,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Discriminator kept in the wire line on purpose. Boot injection and launcher
 * keystrokes land on the same surface, and both the engine's own delivery
 * bookkeeping and the session-identity stripper need to tell them apart from
 * the text alone -- a bare `Read and follow <path>` is indistinguishable from a
 * caller's pointer brief.
 */
export const BOOT_CONTRACT_POINTER_PREFIX = "cmuxlayer contract for";

export function bootContractPointer(
  agentId: string,
  contractPath: string,
): string {
  return `${BOOT_CONTRACT_POINTER_PREFIX} ${agentId}: Read and follow ${contractPath}`;
}

/**
 * Escape hatch for the migration step the brief allows. Default is the pointer;
 * `CMUXLAYER_BOOT_CONTRACT=inline` restores the pre-P11b inline mailbox
 * contract (which, being ~479 chars, still carries NO report contract -- the
 * inline mode is the old behaviour exactly, budget collision included).
 */
export type BootContractMode = "pointer" | "inline";

export function bootContractMode(
  env: NodeJS.ProcessEnv = process.env,
): BootContractMode {
  return env.CMUXLAYER_BOOT_CONTRACT?.trim().toLowerCase() === "inline"
    ? "inline"
    : "pointer";
}

/** Write the contract file, returning its absolute path and exact contents. */
export function writeBootContractFile(
  input: BootContractFileInput,
  opts?: InboxOpts,
): { path: string; content: string } {
  const path = coordinationContractPath(input.agentId, opts);
  const content = renderBootContractFile(input);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return { path, content };
}

/**
 * Pointer-mode provenance, the counterpart to COORDINATION_FOOTER_NOT_DELIVERED.
 * Finding 3 again: a receipt that reports the contract's byte cost must also
 * report HOW it reached the worker, or a lead reads an authoritative-looking
 * number and concludes something the engine never did.
 */
export const COORDINATION_CONTRACT_DELIVERED_NOTE =
  "delivered_via_contract_file: the boot prompt is a one-line pointer at contract_path, which carries the mailbox contract AND report_path/done_marker. The pointer keeps boot delivery under the 500-char chunk threshold, so it is not split. Caveat: an agent that ignores the pointer never reads the contract. That is OBSERVABLE IN PRINCIPLE -- the file is on disk unread, unlike a chunked boot prompt that never submitted -- but NO health or closure path checks it today; nothing here detects it for you. coordination_footer_bytes measures the inline one-line rendering, which is NOT what was sent: the wire carried a ~130-byte pointer and the contract lives in a file of a different size again.";

export const COORDINATION_CONTRACT_POINTER_NOT_VERIFIED =
  "not_delivered: the contract file was written, but its pointer was folded into a boot prompt whose submission was not verified. The LEAD must relay contract_path, report_path, and done_marker to this worker.";

/**
 * Resume provenance (#462 item 2). The contract file is refreshed on resume --
 * idempotent, since both strings derive from agent_id alone -- but no pointer
 * is re-typed into the resuming pane. Reporting `delivered: true` here would be
 * the undisclosed non-delivery this lane exists to eliminate.
 */
export const COORDINATION_CONTRACT_REFRESHED_NOT_REDELIVERED =
  "refreshed_not_redelivered: the spawn contract file at contract_path was rewritten on resume (identical bytes -- both strings derive from agent_id alone), and report_path/done_marker are re-issued and re-persisted. The boot POINTER was NOT re-typed into the resuming pane: `--resume` restores the prior session, which already contains it, and typing into a pane mid-resume is a delivery-path change this did not make. If the resumed session did NOT restore its context, the LEAD must point the worker at contract_path.";
