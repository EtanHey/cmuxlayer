// Real captured text, compacted only by dropping blank padding rows. No model runs.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [row, events] = process.argv.slice(2);
const capture = name => readFileSync(fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url)), "utf8");
const banner = capture("composer-overlays/codex-boot.txt");
const idle = capture("codex-0.157/idle-empty.txt");
const working = capture("codex-0.157/idle-submitted-working.txt");
let draft = "", submitted = "", phase = row === "contract" ? "initializing" : "idle", keys = [], submissions = [];
function render() {
  let frame = row === "banner" ? banner : idle;
  if (phase === "initializing") frame = idle.replace("› Ask Codex to do anything", "Initializing…\nWorking (1s • esc to interrupt)\n› Ask Codex to do anything");
  else if (phase === "working") {
    // Boot specimen: the committed row scrolled away before verification.
    frame = row === "boot" ? working.replace(/› Reply with[^\n]*\n/u, "") :
      banner.replace("› Ask Codex to do anything", `› ${submitted}\nWorking (1s • esc to interrupt)\n› ${draft || "Ask Codex to do anything"}`);
  } else frame = frame.replace("› Ask Codex to do anything", `› ${draft || "Ask Codex to do anything"}`);
  process.stdout.write("\x1b[2J\x1b[H" + frame.split("\n").filter(line => line.trim()).join("\r\n"));
  writeFileSync(events + ".tmp", JSON.stringify({ pid: process.pid, phase, draft, submitted, keys, submissions }));
  renameSync(events + ".tmp", events);
}
if (!process.stdin.isTTY) throw new Error("fixture requires a real terminal");
process.stdin.setRawMode(true); process.stdin.resume(); render();
if (row === "contract") setTimeout(() => { phase = "idle"; render(); }, 300);
process.stdin.on("data", data => {
  // Ignore bracketed-paste delimiters; keys stay attached to this real PTY.
  const text = data.toString().replace(/\x1b\[20[01]~/g, "");
  for (const c of text) {
    if (c === "\x03") process.exit(0);
    if (c === "\x1b") { keys.push("Esc"); continue; } // Daybreak stays visible.
    if (c === "\r" || c === "\n") {
      keys.push(row === "contract" && c === "\n" ? "LF" : "Return");
      if (draft && phase === "idle") {
        submitted = draft; submissions.push(draft); draft = ""; phase = "submitted";
        setTimeout(() => { phase = "working"; render(); }, 200);
      }
    } else if (c === "\x7f") draft = draft.slice(0, -1);
    else if (c >= " ") draft += c;
  }
  render();
});
