import { createHash } from "node:crypto";
/** Internal evidence, not the proposed shared envelope. Never authorizes GC. */
export type DiagnosticMethod = "system.capabilities" | "system.tree" | "system.top" | "debug.terminals" | "window.list" | "workspace.list" | "pane.list" | "surface.list";
export interface KernelIdentity {
  pid: number; ppid: number | null; uid: number | null;
  startSeconds: string | null; startMicroseconds: string | null;
  cwd: string | null;
}
export interface KernelProcess extends KernelIdentity {
  identityAfter: KernelIdentity | null; sessionId: null; errors: string[];
  failures: { operation: string; errno: number | null; identity: KernelIdentity | null }[];
}
export interface KernelObservation {
  before: number[] | null; after: number[] | null;
  processes: KernelProcess[]; reason: string | null;
}
export interface RegistrationEvidence {
  reference: string; digest: string | null; disposition: string; sessionId: string | null;
}
export interface CensusReads {
  native(method: DiagnosticMethod, params?: Record<string, unknown>): Promise<{ value: unknown; generation: string }>;
  kernel(ownerUid: number): Promise<KernelObservation>;
  registrations?(): Promise<RegistrationEvidence[]>;
}
type ObjectEvidence = Record<string, unknown> & { kind: string; id: string | null; parent: string | null };
interface Diagnostic {
  method: DiagnosticMethod; params: Record<string, unknown>; generation: string | null;
  digest: string | null; objects: ObjectEvidence[] | null; reason: string | null;
}
interface NativeBracket { diagnostics: Diagnostic[]; tree: ObjectEvidence[] | null; independent: ObjectEvidence[] | null; reconciled: boolean }
interface Attempt { before: NativeBracket; kernel: ReturnType<typeof kernelEvidence>; after: NativeBracket }
const methods: DiagnosticMethod[] = ["system.tree", "system.top", "debug.terminals", "window.list", "workspace.list", "pane.list", "surface.list"];
const fields = ["pid", "ppid", "surface_id", "workspace_id", "window_id", "pane_id", "type", "mapped", "tree_visible", "runtime_surface_ready", "runtime_surface_created_at", "teardown_requested", "surface_ids"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const sameSet = (a: unknown[], b: unknown[]) => a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const validPid = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const validPath = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && !v.includes("\0");
const tuple = (p: KernelIdentity) => validPid(p.pid) && typeof p.startSeconds === "string" && typeof p.startMicroseconds === "string" && /^[1-9]\d*$/.test(p.startSeconds) && /^(0|[1-9]\d*)$/.test(p.startMicroseconds) && Number(p.startMicroseconds) < 1_000_000 ? `${p.pid}:${p.startSeconds}:${p.startMicroseconds}` : null;
const good = (p: KernelProcess, uid: number) => Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.ppid) && p.ppid! >= 0 && p.uid === uid &&
  tuple(p) !== null && validPath(p.cwd) && !p.errors.length && !p.failures.length && p.identityAfter !== null && p.identityAfter !== undefined &&
  tuple(p.identityAfter) === tuple(p) && p.identityAfter.uid === uid && p.identityAfter.ppid === p.ppid && p.identityAfter.cwd === p.cwd;
// Retain only diagnostic identifiers/state: native titles, argv, env, text and fallback cwd never leave this projection.
function project(value: unknown, root: string, hierarchical: boolean): { objects: ObjectEvidence[] | null; malformed: boolean } {
  if (!Array.isArray((value as Record<string, unknown> | null)?.[root])) return { objects: null, malformed: true };
  const objects: ObjectEvidence[] = []; let malformed = false;
  const walk = (container: unknown, key: string, parent: string | null) => {
    const rows = record(container)?.[key];
    if (!Array.isArray(rows)) { malformed = true; return; }
    for (const raw of rows) {
      const row = record(raw);
      const kind = key === "terminals" ? "terminal" : key.slice(0, -1);
      const id = row && (row.id ?? row[`${kind === "terminal" ? "surface" : kind}_id`]);
      const object: ObjectEvidence = { kind, id: typeof id === "string" ? id : null, parent };
      if (!object.id) malformed = true;
      for (const field of fields) if (row?.[field] !== undefined) {
        const v = row[field];
        if (v === null || ["string", "number", "boolean"].includes(typeof v) || (field === "surface_ids" && Array.isArray(v) && v.every(x => typeof x === "string"))) object[field] = v;
        else malformed = true;
      }
      objects.push(object);
      const child = ({ windows: "workspaces", workspaces: "panes", panes: "surfaces" } as Record<string, string>)[key];
      if (child && hierarchical) walk(row, child, object.id);
      const count = row?.[`${child?.slice(0, -1)}_count`];
      if (child && hierarchical && typeof count === "number" && Array.isArray(row?.[child]) && count !== row[child].length) malformed = true;
    }
  };
  walk(value, root, null);
  const identities = objects.map(o => `${o.kind}:${o.id}`);
  if (new Set(identities).size !== identities.length) malformed = true;
  const count = record(value)?.count;
  if (typeof count === "number" && count !== objects.length) malformed = true;
  const hints = (raw: unknown) => {
    const node = record(raw); if (!node) return;
    if (Number.isSafeInteger(node.pid)) objects.push({ kind: "process-hint", id: String(node.pid), parent: null, ...Object.fromEntries(["pid", "ppid", "cmux_surface_id", "cmux_workspace_id"].map(k => [k, ["number", "string"].includes(typeof node[k]) ? node[k] : null])) });
    for (const child of Object.values(node)) if (typeof child === "object") Array.isArray(child) ? child.forEach(hints) : hints(child);
  };
  if (hierarchical) hints(value);
  return { objects, malformed };
}
const members = (objects: ObjectEvidence[]) => objects.filter(o => ["window", "workspace", "pane", "surface"].includes(o.kind));
const keys = (objects: ObjectEvidence[]) => members(objects).map(o => `${o.kind}:${o.id}`);
const signature = (objects: ObjectEvidence[]) => members(objects).map(o => JSON.stringify([o.kind, o.id, o.parent, o.surface_ids ?? null])).sort().join("\n");

// Evidence fields are projected independently of complete launch validation.
// Rejected rows retain only known scalar fields; never copy arbitrary helper text.
const scalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const identityFields = ["pid", "ppid", "uid", "startSeconds", "startMicroseconds", "cwd"];
const captured = (v: unknown, fields: string[]) => Object.fromEntries(fields.flatMap(k => {
  const row = record(v); return row && scalar(row[k]) ? [[k, row[k]]] : [];
}));
function identityEvidence(v: unknown): KernelIdentity | null {
  const row = record(v);
  if (!row || typeof row.pid !== "number" || !Number.isFinite(row.pid)) return null;
  return { pid: row.pid, ppid: typeof row.ppid === "number" ? row.ppid : null, uid: typeof row.uid === "number" ? row.uid : null,
    startSeconds: typeof row.startSeconds === "string" ? row.startSeconds : null,
    startMicroseconds: typeof row.startMicroseconds === "string" ? row.startMicroseconds : null, cwd: typeof row.cwd === "string" ? row.cwd : null };
}
const identityShape = (v: unknown) => {
  const r = record(v);
  return r !== null && Number.isSafeInteger(r.pid) && [r.ppid, r.uid].every(x => x === null || (Number.isSafeInteger(x) && Number(x) >= 0)) &&
    [r.startSeconds, r.startMicroseconds, r.cwd].every(x => x === null || typeof x === "string");
};
function kernelEvidence(value: unknown) {
  const raw = record(value), processes: KernelProcess[] = [], invalidRows: { index: number; evidence: Record<string, unknown> }[] = [];
  let malformed = !raw || !Array.isArray(raw.processes) || !(raw.reason === null || typeof raw.reason === "string");
  const membership = (v: unknown) => v === null ? null : Array.isArray(v) && v.every(validPid) ? v : (malformed = true, null);
  const before = membership(raw?.before), after = membership(raw?.after);
  for (const [index, value] of (Array.isArray(raw?.processes) ? raw.processes : []).entries()) {
    const row = record(value), identity = identityEvidence(value);
    const rawFailures = Array.isArray(row?.failures) ? row.failures : [];
    const valid = identityShape(value) && (row?.identityAfter === null || identityShape(row?.identityAfter)) && row?.sessionId === null &&
      Array.isArray(row?.errors) && row.errors.every(e => typeof e === "string") && Array.isArray(row?.failures) && rawFailures.every(v => {
        const f = record(v); return f && typeof f.operation === "string" && f.operation.length > 0 &&
          (f.errno === null || (Number.isSafeInteger(f.errno) && Number(f.errno) >= 0)) && (f.identity === null || identityShape(f.identity));
      });
    if (!valid) {
      malformed = true;
      invalidRows.push({ index, evidence: { identity: captured(value, identityFields), identityAfter: captured(row?.identityAfter, identityFields),
        failures: rawFailures.map(f => ({ ...captured(f, ["operation", "errno"]), identity: captured(record(f)?.identity, identityFields) })) } });
    }
    if (!identity) continue;
    processes.push({ ...identity, identityAfter: identityEvidence(row?.identityAfter), sessionId: null,
      errors: [...(Array.isArray(row?.errors) ? row.errors.filter((e): e is string => typeof e === "string") : []), ...(!valid ? ["INVALID_KERNEL_ROW"] : [])],
      failures: rawFailures.flatMap(v => { const f = record(v); return !f ? [] : [{ operation: typeof f.operation === "string" ? f.operation : "unavailable",
        errno: Number.isSafeInteger(f.errno) && Number(f.errno) >= 0 ? Number(f.errno) : null, identity: identityEvidence(f.identity) }]; }) });
  }
  return { before, after, processes, reason: malformed ? "kernel helper invalid output" : typeof raw?.reason === "string" ? raw.reason : null, invalidRows,
    reportedReason: scalar(raw?.reason) ? raw?.reason : null,
    membershipEvidence: { before: Array.isArray(raw?.before) ? raw.before.filter(scalar) : null, after: Array.isArray(raw?.after) ? raw.after.filter(scalar) : null } };
}

/** Two full fresh brackets maximum; matching endpoints witness only the sampled interval (ABA/TOCTOU remains). */
export async function collectCurrentSessionCensus(reads: CensusReads, ownerUid: number) {
  const startedAt = new Date().toISOString();
  const blockers = new Set<string>(["authoritative launch joins unsupported", "host and boot launch binding unsupported", "lifecycle and coverage proof unsupported"]);
  const attempts: Attempt[] = []; let generation: string | null = null;
  const read = async (method: DiagnosticMethod, params: Record<string, unknown> = {}, root?: string): Promise<Diagnostic> => {
    try {
      const result = await reads.native(method, params);
      if (generation !== null && result.generation !== generation) blockers.add("native reconnect");
      generation = result.generation;
      const projection = root ? project(result.value, root, method === "system.tree" || method === "system.top") : { objects: [], malformed: false };
      if (projection.malformed) blockers.add("native malformed or truncated");
      return { method, params, generation, digest: digest(result.value), objects: projection.objects, reason: projection.malformed ? "malformed or truncated" : null };
    } catch {
      blockers.add("native read unavailable");
      return { method, params, generation: null, digest: null, objects: null, reason: "native read failed (capability/transport/unreadable)" };
    }
  };
  // Capability payload is consumed in place, never retained as arbitrary private data.
  try {
    const capability = await reads.native("system.capabilities"); generation = capability.generation;
    const advertised = (capability.value as { methods?: unknown })?.methods;
    if (!Array.isArray(advertised) || methods.some(m => !advertised.includes(m))) blockers.add("native capability missing");
  } catch { blockers.add("native capability missing"); }
  const bracket = async (): Promise<NativeBracket> => {
    let reconciled = !blockers.has("native capability missing");
    const diagnostics: Diagnostic[] = [];
    const tree = await read("system.tree", { all_windows: true }, "windows"); diagnostics.push(tree);
    const top = await read("system.top", { all_windows: true, include_processes: true }, "windows"); diagnostics.push(top);
    const terminals = await read("debug.terminals", {}, "terminals"); diagnostics.push(terminals);
    if (terminals.objects?.some(o => o.mapped !== true || o.runtime_surface_ready !== true)) blockers.add("terminal lifecycle unresolved");
    const windows = await read("window.list", {}, "windows"); diagnostics.push(windows);
    // List responses are flat, unlike tree/top. Their children are independent subsequent RPCs.
    const independent = windows.objects === null ? null : [...windows.objects];
    for (const w of windows.objects ?? []) {
      if (w.kind !== "window" || !w.id) continue;
      const workspaces = await read("workspace.list", { window_id: w.id }, "workspaces"); diagnostics.push(workspaces);
      for (const ws of workspaces.objects ?? []) {
        if (!ws.id) continue; independent?.push({ ...ws, parent: w.id });
        for (const [method, root] of [["pane.list", "panes"], ["surface.list", "surfaces"]] as const) {
          const list = await read(method, { workspace_id: ws.id }, root); diagnostics.push(list);
          independent?.push(...(list.objects ?? []).map(o => ({ ...o, parent: ws.id })));
        }
      }
    }
    for (const surface of independent?.filter(o => o.kind === "surface") ?? []) surface.parent = typeof surface.pane_id === "string" ? surface.pane_id : independent?.find(o => o.kind === "pane" && Array.isArray(o.surface_ids) && o.surface_ids.includes(surface.id))?.id ?? null;
    const mismatch = () => { reconciled = false; blockers.add("native membership mismatch"); };
    if (tree.objects && independent && (!sameSet(keys(tree.objects), keys(independent)) || signature(tree.objects) !== signature(independent))) mismatch();
    for (const pane of tree.objects?.filter(o => o.kind === "pane") ?? []) {
      const listed = independent?.find(o => o.kind === "pane" && o.id === pane.id);
      const nested = tree.objects?.filter(o => o.kind === "surface" && o.parent === pane.id).map(o => o.id) ?? [];
      if (!Array.isArray(pane.surface_ids) || !Array.isArray(listed?.surface_ids) || !sameSet(pane.surface_ids, listed.surface_ids) || !sameSet(pane.surface_ids, nested)) mismatch();
    }
    if (tree.objects && top.objects && signature(tree.objects) !== signature(top.objects)) mismatch();
    if (tree.objects && terminals.objects && tree.objects.some(o => o.kind === "surface" && o.type === "terminal" && !terminals.objects!.some(t => t.id === o.id))) { reconciled = false; blockers.add("diagnostic terminal membership missing"); }
    reconciled &&= !diagnostics.some(d => d.reason) && !blockers.has("native reconnect");
    return { diagnostics, tree: tree.reason ? null : tree.objects, independent: diagnostics.some(d => d.reason) ? null : independent, reconciled };
  };
  let finalMembership: KernelProcess[] | null = null;
  for (let n = 0; n < 2; n++) {
    const before = await bracket(); let kernel: ReturnType<typeof kernelEvidence>;
    try { kernel = kernelEvidence(await reads.kernel(ownerUid)); }
    catch { kernel = { ...kernelEvidence(null), reason: "kernel helper unavailable or invalid output" }; }
    if (kernel.invalidRows.length || kernel.reason === "kernel helper invalid output") blockers.add("kernel output malformed");
    const after = await bracket(); attempts.push({ before, kernel, after });
    const endpoints = kernel.before && kernel.after && sameSet(kernel.before, kernel.after);
    const accounted = kernel.after && sameSet(kernel.after, kernel.processes.map(p => p.pid));
    if (!accounted) blockers.add("kernel membership mismatch");
    const stable = endpoints && accounted && !kernel.reason && Number.isSafeInteger(ownerUid) && ownerUid >= 0 && kernel.processes.every(p => good(p, ownerUid)) &&
      before.reconciled && after.reconciled && before.tree && after.tree && before.independent && after.independent && signature(before.tree) === signature(after.tree) &&
      signature(before.independent) === signature(after.independent);
    if (stable) { finalMembership = kernel.processes; break; }
    if (n === 1) blockers.add("bounded rebracket exhausted");
  }
  const observations = attempts.flatMap(a => a.kernel.processes);
  const resolutions = observations.flatMap((p, observationIndex) => p.failures.flatMap((failure, failureIndex) => {
    if (failure.errno !== 3) return [];
    const replacement = finalMembership?.find(q => q.pid === p.pid);
    const historicalIdentityKnown = Number.isSafeInteger(ownerUid) && ownerUid >= 0 && failure.identity !== null && failure.identity.pid === p.pid && failure.identity.uid === ownerUid && tuple(failure.identity) !== null;
    const historicalPathKnown = validPath(failure.identity?.cwd);
    const invalidHistory = !validPid(p.pid) || p.errors.includes("INVALID_KERNEL_ROW") || (failure.identity !== null && (!historicalIdentityKnown || !historicalPathKnown));
    const disposition = finalMembership === null || invalidHistory ? "unresolved" : !replacement ? "disappeared" : historicalIdentityKnown && tuple(failure.identity!) !== tuple(replacement) ? "reused" : "unresolved";
    if (!historicalIdentityKnown || !historicalPathKnown) blockers.add("historical launch or path unknown");
    return [{ pid: p.pid, observationIndex, failureIndex, finalAttempt: attempts.length - 1, historicalIdentityKnown, disposition }];
  }));
  if (observations.some(p => p.errors.some(e => e !== "ESRCH") || p.failures.some(f => f.errno !== 3) || (!good(p, ownerUid) && !p.failures.some(f => f.errno === 3))) || resolutions.some(r => r.disposition === "unresolved")) blockers.add("kernel evidence unresolved");
  let registrations: { reference: string | null; digest: string | null; disposition: string; sessionId: string | null }[] | null = null;
  const invalidRegistrations: { index: number; evidence: Record<string, unknown> }[] = [];
  try {
    const rows = await reads.registrations?.();
    if (Array.isArray(rows)) registrations = rows.map((raw, index) => {
      const row = record(raw), string = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
      const valid = row && string(row.reference) && string(row.disposition) && (row.digest === null || string(row.digest)) && (row.sessionId === null || string(row.sessionId));
      if (!valid) { blockers.add("registration row malformed or unavailable"); invalidRegistrations.push({ index, evidence: captured(raw, ["reference", "digest", "disposition", "sessionId"]) }); }
      return { reference: string(row?.reference) ? row.reference : null, digest: string(row?.digest) ? row.digest : null,
        disposition: valid ? String(row.disposition) : "malformed", sessionId: string(row?.sessionId) ? row.sessionId : null };
    });
  } catch { /* never substitute an empty membership */ }
  if (registrations === null) blockers.add("registration coverage unavailable");
  return { status: "INCOMPLETE" as const, ownerUid, startedAt, completedAt: new Date().toISOString(), attempts, observations, finalMembership,
    finalMembershipReason: finalMembership === null ? "no stable fully accounted kernel/native bracket" : null,
    resolutions, registrations, invalidRegistrations, blockers: [...blockers], witness: "scoped interval only; residual ABA/TOCTOU; no removal authority" };
}
