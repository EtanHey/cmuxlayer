import { readFileSync } from "node:fs";
import { shellQuote } from "./target.mjs";

function recordInvocation() {
  const [file, launcher, cwd, pid, ...argv] = process.argv.slice(1);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  require("node:fs").appendFileSync(file, JSON.stringify({ launcher, pid: Number(pid), launch_cwd: cwd,
    effective_argv: argv, actual_launch_command: [launcher, ...argv].map(quote).join(" "),
    command_provenance: "observed dispatcher-boundary argv", cwd_provenance: "forwarded -w argument" }) + "\n", { mode: 0o600 });
}

// Appended only to the run-owned .zshenv AFTER dispatcher registration. Copy
// the existing function body, preserving the target launcher and replay SHA.
export function launcherCwdStartup(opts) {
  if (opts.target !== "m1-gate" || !opts.launcherMode || !opts.launchCwd) return "";
  if (!opts.launchReceipt || !opts.launchCwd.startsWith("/")) throw new Error("private launch cwd/receipt missing");
  const record = `(${recordInvocation.toString()})()`, array = '${_xmac_args[@]}';
  return (opts.launcherClis ?? ["codex", "claude"]).map(cli => {
    const launcher = opts.launchers?.[cli];
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(launcher ?? "")) throw new Error("cwd shim launcher missing or invalid");
    const original = `_xmac_original_${launcher}`;
    return `(( $+functions[${launcher}] )) || return 2
functions[${original}]=$functions[${launcher}]
${launcher}() {
  local _xmac_cwd=${shellQuote(opts.launchCwd)} _xmac_arg _xmac_previous='' _xmac_explicit=0
  for _xmac_arg in "$@"; do
    case "$_xmac_previous" in
      -w|--worktree)
        [[ -n "$_xmac_arg" && "$_xmac_arg" != -* ]] || return 2
        _xmac_cwd="$_xmac_arg"; _xmac_explicit=1; _xmac_previous=''; continue ;;
      -m|--model|-E|--effort|-p|--print) _xmac_previous=''; continue ;;
    esac
    [[ "$_xmac_arg" != '--' ]] || break
    _xmac_previous="$_xmac_arg"
  done
  [[ "$_xmac_previous" != '-w' && "$_xmac_previous" != '--worktree' ]] || return 2
  local -a _xmac_args=("$@")
  (( _xmac_explicit )) || _xmac_args=(-w "$_xmac_cwd" "${array}")
  ${shellQuote(process.execPath)} -e ${shellQuote(record)} -- ${shellQuote(opts.launchReceipt)} ${shellQuote(launcher)} "$_xmac_cwd" "$$" "${array}" || return
  ${original} "${array}"
}
`;
  }).join("");
}

export function launchRecords(path) {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
