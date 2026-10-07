import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { shellQuote } from "./target.mjs";

// Exercise the registered launcher with the SAME ZDOTDIR as the pane. Intercept
// only the CLI executable; its model flag assembly remains the target's code.
export function checkLauncherArgv(env, opts, launchers) {
  if (!opts.launcherMode || !(opts.launcherClis ?? ["codex", "claude"]).includes("codex")) return null;
  const launcher = launchers?.codex, model = "gpt-6-luna";
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(launcher ?? "")) throw new Error("argv preflight launcher missing or invalid");
  const root = mkdtempSync(join(tmpdir(), "cmux-xmac-argv-")), capture = join(root, "argv.json"), shim = join(root, "codex");
  try {
    mkdirSync(join(root, "codex-home"), { mode: 0o700 });
    // Never persist inline MCP env/config secrets or prompt contents. The model
    // elements remain verbatim; all other arguments are represented by position.
    writeFileSync(shim, `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(1).map(a => a === '--model' || a === ${JSON.stringify(model)} || a.startsWith('--model ') ? a : '[other argument]')))`)} -- "$@"\n`, { mode: 0o700 });
    const command = `export CODEX_HOME=${shellQuote(join(root, "codex-home"))} PATH=${shellQuote(root)}:"$PATH" CMUX_CUSTOM_CODEX_PATH=${shellQuote(shim)} REPOGOLEM_ALLOW_MODEL=1; codex() { ${shellQuote(shim)} "$@"; }; ${launcher} -s --worker -m ${model} -E low`;
    const result = spawnSync("/bin/zsh", ["-lic", command], { env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
    let argv = []; try { argv = JSON.parse(readFileSync(capture, "utf8")); } catch { /* Missing shim receipt fails closed. */ }
    const indices = argv.flatMap((arg, i) => arg === "--model" ? [i] : []);
    const ok = result.status === 0 && indices.length === 1 && argv[indices[0] + 1] === model && !argv.some(arg => arg.startsWith("--model "));
    const row = { status: ok ? "PASS" : "PRECONDITION_ABSENT", kind: "launcher_argv", launcher, model, observed_argv: argv,
      exit_code: result.status, reason: ok ? null : result.error?.code ?? "separate --model/model elements absent" };
    if (!ok) throw Object.assign(new Error(`PRECONDITION_ABSENT: ${JSON.stringify(row)}`), { precondition: row });
    return row;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
