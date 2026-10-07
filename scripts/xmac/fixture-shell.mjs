import { execFileSync } from "node:child_process";
import { shellQuote } from "./target.mjs";
import { verifyFixtureLaunchers } from "./fixture-launchers.mjs";

// The same login startup as the native anchor/probe; only resolve the CLI name.
// Explicit owned Node helper preflight never executes the resolved CLI.
export function verifyFixtureShell(install, env, exec = execFileSync) {
  verifyFixtureLaunchers(install, env);
  const { node, helper } = install.attestation.files;
  const command = `printf '%s\\n' "$(command -v codex)"; ${shellQuote(node.path)} ${shellQuote(helper.path)} launcher codex --xmac-preflight`;
  const output = exec("/bin/zsh", ["-lc", command], { env, cwd: install.root, encoding: "utf8", timeout: 5000 }).trim().split("\n");
  const resolved = output[0], preflight = JSON.parse(output[1]);
  if (resolved !== install.binaries.codex || output.length !== 2 || preflight.fixture !== true ||
      preflight.cli !== "codex" || preflight.executable !== helper.path) throw new Error("fixture login-shell resolution changed");
  verifyFixtureLaunchers(install, env);
  return { shell: "/bin/zsh -lc", anchor: "/bin/zsh -l", resolved, helper: preflight, startup: ".zshenv + final .zlogin" };
}
