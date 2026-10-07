import { execFileSync } from "node:child_process";

export function normalizeProcessIdentity(value) {
  const match = /^\s*(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(value);
  if (!match) throw new Error("process identity unreadable");
  return `${Number(match[1])} ${match[2]} ${match[3]}`;
}

export function parseHumanSessionApproval(value) {
  if (value === undefined || value === "") return null;
  const match = typeof value === "string" && /^(\d+):([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.exec(value);
  if (!match || match[0] !== value || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 1) throw new Error("human-session approval requires exact <pid>:<ps lstart time>");
  return { pid: Number(match[1]), start_time: match[2] };
}

// comm, never args: commands/configuration may contain credentials. PPID is
// live process ancestry, not evidence of the person who requested an LS launch.
export function observeCmuxSessions(probe = execFileSync) {
  const text = probe("ps", ["-axo", "pid=,ppid=,lstart=,comm="], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
  const rows = text.split("\n").filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
    if (!match) { if (/\/Contents\/MacOS\/cmux\s*$/.test(line)) throw new Error("cmux process identity unreadable"); return null; }
    return { pid: Number(match[1]), ppid: Number(match[2]), start_time: match[3], executable: match[4] };
  }).filter(Boolean);
  return rows.filter(row => /\.app\/Contents\/MacOS\/cmux$/.test(row.executable)).map(row => ({
    ...row, identity: `${row.pid} ${row.start_time} ${row.executable}`,
    launch_parent: { pid: row.ppid, executable: rows.find(parent => parent.pid === row.ppid)?.executable ?? null, source: "live_ppid" },
  }));
}

export function assertM1CmuxMutation(sessions, receipt, operation = "quit") {
  const approval = parseHumanSessionApproval(receipt?.human_session_quit_approval?.value);
  const owned = receipt?.app_process;
  const classified = sessions.map(session => ({ ...session,
    provenance: owned?.pid === session.pid && owned.start_time === session.start_time && owned.saved === session.identity &&
      owned.launch_token && owned.launch_token === receipt.launch_token ? "harness_owned" : "human_session",
    quit_approved: !receipt?.human_session_quit_approval?.consumed && approval?.pid === session.pid && approval.start_time === session.start_time,
  }));
  if (receipt) (receipt.cmux_session_checks ??= []).push({ operation, sessions: classified });
  const blocked = classified.filter(session => session.provenance === "human_session" && !session.quit_approved);
  // Approval permits quitting only. Replacing a bundle under ANY live instance
  // remains forbidden, even if that instance has a matching quit approval.
  if (blocked.length || ["replace", "launch"].includes(operation) && classified.length) {
    const precondition = { status: "PRECONDITION_ABSENT", kind: "human_cmux_session", operation, sessions: blocked.length ? blocked : classified };
    throw Object.assign(new Error(`PRECONDITION_ABSENT: human_cmux_session (existing stable or unowned cmux): ${JSON.stringify(precondition)}`), { precondition });
  }
  return classified;
}

export function humanSessionApprovalArgument(arg, opts) {
  const prefix = "--human-session-quit-approved=";
  if (!arg.startsWith(prefix)) return false;
  if (opts.humanSessionQuitApproved !== undefined) throw new Error("duplicate human-session approval");
  const value = arg.slice(prefix.length);
  if (!parseHumanSessionApproval(value)) throw new Error("empty human-session approval");
  opts.humanSessionQuitApproved = value; return true;
}
