// Deterministic input behavior, driven by actual PTY bytes; never delivery receipts.
export function createFixtureComposer({ schedule = setTimeout, changed = () => {}, accepted = () => {}, respond = text =>
  text.match(/Reply exactly ([A-Za-z0-9_]+)/i)?.[1] ?? (text.startsWith("Run sleep ") ? "BUSY_DONE" : "FIXTURE_ACK") } = {}) {
  const state = { draft: "", submitted: "", phase: "idle", keys: [], replies: [], pending: [], turns: [] };
  const submit = text => {
    state.submitted = text; state.turns.push(text); state.phase = "submitted"; accepted(text);
    schedule(() => {
      state.phase = "working"; changed();
      const duration = Number(text.match(/^Run sleep (\d+) then reply BUSY_DONE\.$/)?.[1] ?? 0);
      schedule(() => {
        const finish = reply => {
          state.replies.push(reply); state.phase = "idle";
          const next = state.pending.shift();
          if (next) submit(next.text);
          changed();
        };
        const reply = respond(text);
        if (reply?.then) void reply.then(finish, error => { state.error = String(error); changed(); });
        else finish(reply);
      }, duration ? duration * 1000 : 800);
    }, 200);
  };
  const input = text => {
    for (const c of text.replace(/\x1b\[20[01]~/g, "")) {
      if (c === "\r" || c === "\n" || c === "\t") {
        state.keys.push(c === "\t" ? "Tab" : "Return");
        if (state.draft) {
          const submitted = state.draft; state.draft = "";
          if (state.phase === "idle") submit(submitted);
          else state.pending.push({ text: submitted, mode: c === "\t" ? "queue" : "steer" });
        }
      } else if (c === "\x7f") state.draft = Array.from(state.draft).slice(0, -1).join("");
      else if (c === "\x1b") state.keys.push("Esc");
      else if (c >= " ") state.draft += c;
    }
    changed();
  };
  return { state, input };
}
