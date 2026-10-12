import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const names = ["session_id", "surface_uuid", "pid", "cwd", "worktree_path", "launch_cwd", "cli", "launcher", "ts", "session_path"] as const;
type Field = typeof names[number];
type Claim = { kind: string; value: string | number | boolean | null; usable: boolean; numberLexeme?: string; numericBoundaryObserved?: boolean };
export interface RegistrationRow {
  reference: string; registryId: string; rowNumber: number; byteOffset: number;
  byteLength: number; delimiter: "LF" | "EOF" | "UNKNOWN";
  digest: string | null; prefixDigest: string; disposition: "unresolved" | "malformed";
  sessionId: string | null; claims: Partial<Record<Field, Claim[]>>; reasons: string[];
  capturedLaunch: null; harnessProcessRef: null;
  missingEvidence: Record<"host" | "boot" | "uid" | "kernelStart" | "harnessProcess" | "session", string | null>;
}
export interface RegistrationObservation {
  source: { path: string; selection: "CMUXLAYER_SESSION_REGISTRY" | "default"; registryId: string | null };
  content: "observed" | "unavailable"; rows: RegistrationRow[]; observedBytes: number;
  readStartedAt: string; readCompletedAt: string | null;
  unknownRemainder: { byteOffset: number; reason: string } | null;
  finalCoverage: null; coverageReason: string; reasons: string[];
}
type IO = { open(path: string, flags: string | number): Promise<Pick<FileHandle, "read" | "stat" | "close">>; stat: typeof stat };
type Options = { env?: Record<string, string | undefined>; home?: string; maxBytes?: number; maxRows?: number; maxRowBytes?: number; io?: IO };
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 4096 && !/[\u0000\uD800-\uDFFF]/u.test(v);

// A bounded lexical projection, not a replacement JSON parser. JSON.parse only
// checks syntax; it never supplies fields. Complete prefix claims survive failure.
// Repeated keys retain all occurrences. Compound values retain kind, not contents.
function fields(bytes: Buffer) {
  const claims: RegistrationRow["claims"] = {}, reasons: string[] = [];
  let text: string | null = null;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { reasons.push("invalid UTF-8"); }
  try { const parsed = text === null ? null : JSON.parse(text); if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") reasons.push("not an object"); }
  catch { reasons.push("malformed or partial JSON"); }
  // Latin-1 preserves byte boundaries for lexical scanning; each retained token
  // is independently decoded strictly as UTF-8, so invalid siblings lose no fields.
  const lexical = bytes.toString("latin1");
  const decode = (raw: string) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw, "latin1")));
  const token = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|[{}\[\]:,]|[^\s"{}\[\]:,]+)/gy;
  const tokens: { raw: string; end: number }[] = []; let match: RegExpExecArray | null;
  while ((match = token.exec(lexical))) tokens.push({ raw: match[1], end: token.lastIndex });
  type Phase = "key" | "colon" | "value" | "after" | "ambiguous";
  const stack: { kind: string; keys: Set<string>; phase: Phase; root: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].raw, parent = stack.at(-1);
    if (t === "{" || t === "[") {
      if (parent) parent.phase = parent.phase === "value" ? "after" : "ambiguous";
      stack.push({ kind: t, keys: new Set(), phase: "key", root: i === 0 && t === "{" });
      continue;
    }
    if (t === "}" || t === "]") {
      if (parent?.kind === (t === "}" ? "{" : "[")) stack.pop();
      else if (parent) parent.phase = "ambiguous";
      continue;
    }
    const object = stack.at(-1);
    if (object?.kind !== "{") continue;
    // Only a member position establishes a key. Extra private value tokens stay
    // ambiguous until an observed comma at this same object depth restores it.
    if (t === ",") { object.phase = "key"; continue; }
    if (t === ":") { object.phase = object.phase === "colon" ? "value" : "ambiguous"; continue; }
    if (object.phase === "value") { object.phase = "after"; continue; }
    if (object.phase !== "key" || !t.startsWith('"') || tokens[i + 1]?.raw !== ":") {
      object.phase = "ambiguous";
      continue;
    }
    object.phase = "colon";
    let key: string;
    try { key = decode(t); } catch { reasons.push("invalid key encoding"); continue; }
    if (object.keys.has(key)) reasons.push("duplicate key");
    object.keys.add(key);
    if (!object.root || !names.includes(key as Field)) continue;
    const raw = tokens[i + 2]?.raw, field = key as Field;
    const compound = raw === "{" || raw === "[";
    let value: Claim["value"] = null;
    let kind = raw === undefined ? "incomplete" : compound ? raw === "{" ? "object" : "array" : "invalid";
    if (raw !== undefined && !compound) {
      try { value = decode(raw); kind = value === null ? "null" : typeof value; }
      catch { reasons.push(`invalid ${field} encoding or token`); }
    }
    const numericAtom = kind === "number" || (kind === "invalid" && /^-?[\d.eE+-]+$/.test(raw ?? ""));
    // EOF of a projection/read prefix is not an observed numeric terminator.
    const numericBoundaryObserved = /[ \t\r\n,}\]]/.test(lexical[tokens[i + 2]?.end ?? lexical.length] ?? "");
    if (numericAtom && !numericBoundaryObserved) {
      kind = "incomplete-number"; value = null;
      reasons.push(`incomplete ${field} numeric atom; boundary unobserved`);
    }
    const numeric = field === "pid" || field === "ts";
    const usable = numeric ? numericBoundaryObserved && typeof value === "number" && Number.isSafeInteger(value) && /^(0|[1-9]\d*)$/.test(raw ?? "") && value >= (field === "pid" ? 1 : 0) : validText(value);
    const claim: Claim = { kind, value: typeof value === "number" && !Number.isSafeInteger(value) ? null : value, usable };
    if (numericAtom) { claim.numberLexeme = raw; claim.numericBoundaryObserved = numericBoundaryObserved; }
    (claims[field] ??= []).push(claim);
    if (!usable) reasons.push(`invalid ${field} claim`);
  }
  return { claims, reasons: [...new Set(reasons)] };
}

/** Raw rows INCLUDE their LF byte, including preceding CR; no CRLF normalization.
 * A final nonempty unterminated row includes every byte and uses EOF. A terminal
 * LF creates no extra row; blank LF rows are witnesses. Bounds/failure prefixes
 * use UNKNOWN and null full digest, with a separately identified prefix digest.
 * These SHA256 bytes are unrelated to envelope JCS. No registration is a join.
 * Construction/import performs no I/O; callers explicitly inject this reader.
 */
export function createRegistrationReader(options: Options = {}): () => Promise<RegistrationObservation> {
  const env = options.env ?? process.env;
  const override = env.CMUXLAYER_SESSION_REGISTRY;
  const source = { path: resolve(override ?? join(options.home ?? homedir(), ".cmuxlayer/session-registry.jsonl")),
    selection: override === undefined ? "default" as const : "CMUXLAYER_SESSION_REGISTRY" as const, registryId: null as string | null };
  const io = options.io ?? { open, stat };
  const maxBytes = options.maxBytes ?? 1024 * 1024, maxRows = options.maxRows ?? 10000, maxRowBytes = options.maxRowBytes ?? 65536;
  if (![maxBytes, maxRows, maxRowBytes].every(n => Number.isSafeInteger(n) && n > 0) || maxBytes > 16 * 1024 * 1024 || maxRows > 100000 || maxRowBytes > maxBytes) throw new Error("invalid registration bounds");
  return async () => {
    const result: RegistrationObservation = { source: { path: source.path, selection: source.selection, registryId: null },
      content: "unavailable", rows: [], observedBytes: 0, unknownRemainder: null, finalCoverage: null,
      readStartedAt: new Date().toISOString(), readCompletedAt: null,
      coverageReason: "stored rows cannot prove all-launch coverage; hooks can skip or fail open", reasons: [] };
    let handle: Awaited<ReturnType<IO["open"]>> | undefined, pending = Buffer.alloc(0), offset = 0, eof = false;
    const unknown = (reason: string, byteOffset = offset) => {
      result.reasons.push(reason);
      if (!result.unknownRemainder || byteOffset < result.unknownRemainder.byteOffset) result.unknownRemainder = { byteOffset, reason };
    };
    const row = (bytes: Buffer, delimiter: RegistrationRow["delimiter"]) => {
      const oversized = bytes.length > maxRowBytes, projected = fields(bytes.subarray(0, maxRowBytes));
      const reasons = projected.reasons;
      if (oversized) reasons.push("oversized row; fields beyond prefix unknown");
      if (delimiter === "UNKNOWN") reasons.push("partial byte witness; remainder unknown");
      const sessions = projected.claims.session_id, sessionId = sessions?.length === 1 && sessions[0].usable ? sessions[0].value as string : null;
      const rowNumber = result.rows.length + 1, registryId = result.source.registryId!;
      result.rows.push({ reference: `${registryId}:row:${rowNumber}`, registryId, rowNumber, byteOffset: offset,
        byteLength: bytes.length, delimiter, digest: delimiter === "UNKNOWN" ? null : hash(bytes), prefixDigest: hash(bytes),
        disposition: reasons.length ? "malformed" : "unresolved", sessionId, claims: projected.claims, reasons,
        capturedLaunch: null, harnessProcessRef: null, missingEvidence: { host: "not authoritatively observed", boot: "not authoritatively observed",
          uid: "not authoritatively observed", kernelStart: "parent PID is only a claim", harnessProcess: "no authoritative launch witness",
          session: sessionId === null ? "missing, invalid or ambiguous session claim" : null } });
      offset += bytes.length;
    };
    try {
      // Nonblocking open lets the regular-file check reject FIFOs without hanging.
      handle = await io.open(source.path, constants.O_RDONLY | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("not regular file");
      result.source.registryId = `${source.path}#dev=${before.dev};ino=${before.ino}`;
      while (result.observedBytes < maxBytes && result.rows.length < maxRows) {
        const buffer = Buffer.alloc(Math.min(4096, maxBytes - result.observedBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, result.observedBytes);
        result.content = "observed";
        if (!bytesRead) { eof = true; break; }
        result.observedBytes += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let lf: number;
        while (result.rows.length < maxRows && (lf = pending.indexOf(10)) >= 0) {
          row(pending.subarray(0, lf + 1), "LF"); pending = pending.subarray(lf + 1);
        }
      }
      if (!eof) unknown("read bound reached; remainder unknown");
      if (pending.length && result.rows.length < maxRows) { row(pending, eof ? "EOF" : "UNKNOWN"); pending = Buffer.alloc(0); }
      const after = await handle.stat(), selected = await io.stat(source.path);
      if (after.size < before.size) unknown("source truncated during read", 0);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) unknown("source changed during read", 0);
      if (selected.dev !== before.dev || selected.ino !== before.ino) unknown("selected source rotated during read", 0);
      if (selected.size !== after.size || selected.mtimeMs !== after.mtimeMs || selected.ctimeMs !== after.ctimeMs) unknown("selected source changed after descriptor read", 0);
    } catch {
      if (pending.length && result.rows.length < maxRows) row(pending, "UNKNOWN");
      unknown("source unavailable or read/stat failed; remainder unknown");
    } finally {
      try { await handle?.close(); } catch { unknown("source close failed"); }
    }
    result.readCompletedAt = new Date().toISOString();
    return result;
  };
}
