/** Raise a fresh shell's nofile soft limit without lowering an existing one. */
export const RAISE_NOFILE_SOFT_LIMIT = [
  "cmux_nf_s=$(ulimit -Sn);",
  "cmux_nf_h=$(ulimit -Hn);",
  '[ "$cmux_nf_s" = unlimited ] || [ "$cmux_nf_s" -ge 65536 ] ||',
  '{ [ "$cmux_nf_h" = unlimited ] && cmux_nf_h=65536;',
  '[ "$cmux_nf_h" -gt 65536 ] && cmux_nf_h=65536;',
  'ulimit -Sn "$cmux_nf_h"; }',
].join(" ");

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

export function withRaisedNofileSoftLimit(
  command: string,
  shellPath: string | undefined = process.env.SHELL,
): string {
  // The pane uses the user's shell. A POSIX assignment is a parse error in
  // fish, so preserve the launch command when the shell is not known POSIX.
  const shell = shellPath?.split("/").at(-1)?.replace(/^-/, "");
  if (!shell || !POSIX_SHELLS.has(shell)) return command;
  if (command.startsWith("cmux_nf_s=$(ulimit -Sn);")) return command;
  return `${RAISE_NOFILE_SOFT_LIMIT}; ${command}`;
}

/** The shell is replaced by the child, preserving the PID observed by callers. */
export function nofileExecSpec(executable: string, args: string[]): {
  command: string;
  args: string[];
} {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      `${RAISE_NOFILE_SOFT_LIMIT}; exec \"$@\"`,
      "cmuxlayer-nofile",
      executable,
      ...args,
    ],
  };
}
