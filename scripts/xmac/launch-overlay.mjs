export function classifyLaunchOverlay(text) {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").split("\n").map(line => line.trimEnd());
  const selected = lines.findIndex(line => /^\s*[›❯>]\s*\d+[.)]\s+\S/u.test(line));
  if (selected < 0 || lines.filter(line => /^\s*(?:[›❯>]\s*)?\d+[.)]\s+\S/u.test(line)).length < 2) return null;
  const first_lines = lines.slice(Math.max(0, selected - 2), selected + 8);
  const overlay = /Trust and continue/i.test(first_lines.join("\n")) ? "trust" : /Update now/i.test(first_lines.join("\n")) ? "update" : "numbered_picker";
  return { status: "PRECONDITION_ABSENT", kind: "launch_overlay", overlay, first_lines };
}

// Observe only new run-owned surfaces while the MCP spawn is pending. Never
// send input, choose Trust, or dismiss a picker. The owner closes the runtime.
export async function guardLaunch(start, { frames, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let outcome;
  // Both settlement handlers remain attached if an overlay wins first. Closing
  // the private client/runtime can then reject its pending spawn safely.
  void Promise.resolve().then(start).then(result => { outcome = { result }; }, error => { outcome = { error }; });
  do {
    for (const frame of await frames()) {
      const row = classifyLaunchOverlay(frame.text);
      if (row) throw Object.assign(new Error(`PRECONDITION_ABSENT: ${JSON.stringify(row)}`), { precondition: { ...row, surface: frame.surface } });
    }
    if (outcome) { if (outcome.error) throw outcome.error; return outcome.result; }
    await sleep(100);
  } while (true);
}
