/**
 * Command text validation module.
 *
 * Assesses whether a piece of text — a terminal command or an agent task
 * description — should be **allowed**, **denied**, or flagged for
 * **confirmation**.
 *
 * ## Terminal context
 * Text is treated as a literal shell command: deny-patterns and
 * require-confirmation patterns are applied strictly.
 *
 * ## Agent-task context
 * Natural-language discussion *about* dangerous commands (e.g. *"check if
 * rm -rf appears in the codebase"*) is allowed.  Only direct attempts to
 * execute destructive operations or expose secrets are blocked.
 */

import type { Policy } from "./policy-schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Risk level assessed for a given command text. */
export type CommandRisk = "allowed" | "denied" | "confirmation_required";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse *text* against the command policy and return its risk level.
 *
 * ### Terminal context
 * 1. If it matches any `deny_patterns` → `"denied"`
 * 2. Else if it matches any `require_confirmation_patterns` →
 *    `"confirmation_required"`
 * 3. Else → `"allowed"`
 *
 * ### Agent-task context
 * - Direct destructive commands are blocked.
 * - *Discussing* or *analysing* dangerous commands is allowed.
 * - Commands that try to read secrets (e.g. `cat ~/.ssh/id_rsa`) are always
 *   denied regardless of NL framing.
 *
 * @param text    Command string or task description.
 * @param policy  Parsed policy.
 * @param context Execution context.
 * @returns Risk level.
 */
export function checkCommandText(
  text: string,
  policy: Policy,
  context: "terminal" | "agent_task",
): CommandRisk {
  const cmdPolicy = policy.commands;
  if (!cmdPolicy) {
    return "allowed";
  }

  const denyPatterns = cmdPolicy.deny_patterns ?? [];
  const confirmPatterns = cmdPolicy.require_confirmation_patterns ?? [];

  if (context === "terminal") {
    // Strict mode: treat text as a literal command
    if (isDangerousPattern(text, denyPatterns)) {
      return "denied";
    }
    if (isDangerousPattern(text, confirmPatterns)) {
      return "confirmation_required";
    }
    return "allowed";
  }

  // Agent-task context: be smart about NL vs direct commands

  // 1. Check deny patterns — only if the text looks like a direct command
  if (findDirectDangerousMatch(text, denyPatterns)) {
    return "denied";
  }

  // 2. Check confirmation patterns — again only for direct commands
  if (findDirectDangerousMatch(text, confirmPatterns)) {
    return "confirmation_required";
  }

  return "allowed";
}

/**
 * Check whether *text* matches any of the wildcard *patterns*.
 *
 * Each pattern may contain `*` as a wildcard that matches any sequence of
 * characters.  Matching is case-insensitive and ignores leading/trailing
 * whitespace.
 *
 * @param text     String to test.
 * @param patterns Array of wildcard patterns.
 * @returns `true` if at least one pattern matches.
 */
export function isDangerousPattern(text: string, patterns: string[]): boolean {
  const normalised = text.trim().toLowerCase();

  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;

    const regex = wildcardToRegex(pattern);
    if (regex.test(normalised)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers — smart agent-task detection
// ---------------------------------------------------------------------------

/**
 * Phrases that indicate the text is discussing or analysing a command
 * rather than asking to execute it.
 */
const DISCUSSION_INDICATORS: string[] = [
  "check if",
  "check whether",
  "look for",
  "search for",
  "find ",
  "detect ",
  "scan ",
  "identify ",
  "review ",
  "audit ",
  "analyse ",
  "analyze ",
  "examine ",
  "inspect ",
  "show me",
  "tell me",
  "what is",
  "what are",
  "how does",
  "explain ",
  "describe ",
  "document ",
  "list ",
  "does ",
  "is there",
  "are there",
  "has ",
  "have ",
  "in the code",
  "in the file",
  "in the project",
  "in the repo",
  "in the repository",
  "in the script",
  "in the output",
  "in the log",
  "appears in",
  "appearing in",
  "appears",
  "used in",
  "mentioned",
  "reference",
  "contains",
  "containing",
  "search",
];

/**
 * Command fragments that are *always* denied in agent context regardless of
 * NL framing — these represent direct attempts to exfiltrate secrets or
 * access sensitive data.
 */
const ALWAYS_DENIED_COMMANDS: string[] = [
  "cat ~/.ssh/",
  "cat /root/.ssh/",
  "cat /home/",
  "cat .env",
  "cat *.pem",
  "cat *.key",
  "cat id_rsa",
  "cat id_ed25519",
  "cat authorized_keys",
  "cat known_hosts",
  "cat /etc/shadow",
  "cat /etc/passwd",
  "printenv",
  "env |",
  "echo $",
  "curl -",
  "wget -",
  "nc -",
  "netcat",
  "ncat",
  "telnet ",
  "scp ",
  "sftp ",
  "rsync -",
  "dd if=",
  "mkfs.",
  "> /dev/sd",
  "> /dev/hd",
  ":(){ :|:& };:",
  "chmod -R 777 /",
  "chown -R",
];

/**
 * Like `isDangerousPattern` but only returns a match when the text also
 * looks like a *direct command* (not a discussion about one).
 */
function findDirectDangerousMatch(
  text: string,
  patterns: string[],
): string | null {
  const normalised = text.trim().toLowerCase();

  // 1. Always-blocked commands — exempt only if clearly a discussion
  for (const cmd of ALWAYS_DENIED_COMMANDS) {
    if (normalised.includes(cmd.toLowerCase())) {
      if (isClearlyDiscussion(normalised)) {
        continue;
      }
      return cmd;
    }
  }

  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;

    const regex = wildcardToRegex(pattern);
    if (!regex.test(normalised)) continue;

    // Pattern matched — decide if it's a direct command or discussion
    if (isClearlyDiscussion(normalised)) continue;
    if (looksLikeDirectCommand(normalised)) return raw;
    // Conservative default: if ambiguous, allow it
  }

  return null;
}

/**
 * Return `true` when the text contains strong indicators of being a
 * natural-language *discussion* about a command.
 */
function isClearlyDiscussion(text: string): boolean {
  for (const indicator of DISCUSSION_INDICATORS) {
    if (text.includes(indicator.toLowerCase())) return true;
  }
  return false;
}

/**
 * Command verbs that indicate a direct invocation.
 */
const DIRECT_COMMAND_VERBS: string[] = [
  "sudo ",
  "rm ",
  "rm\t",
  "rmdir ",
  "chmod ",
  "chown ",
  "mv ",
  "mv\t",
  "cp ",
  "cp\t",
  "scp ",
  "dd ",
  "mkfs",
  "fdisk",
  "parted",
  "git push",
  "git reset",
  "git clean",
  "git revert",
  "git rebase",
  "git merge",
  "git cherry-pick",
  "git checkout -",
  "docker ",
  "kubectl ",
  "helm ",
  "terraform destroy",
  "pulumi destroy",
  "npm publish",
  "npm unpublish",
  "npm deprecate",
  "npx ",
  "yarn ",
  "pnpm ",
  "pip install",
  "pip uninstall",
  "apt ",
  "apt-get ",
  "yum ",
  "dnf ",
  "pacman ",
  "systemctl ",
  "service ",
  "kill ",
  "killall ",
  "pkill ",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "curl ",
  "wget ",
  "ssh ",
  "telnet ",
  "nc ",
  "ncat ",
  "socat ",
  "screen ",
  "tmux ",
  "bash ",
  "sh ",
  "zsh ",
  "fish ",
  "python ",
  "python3 ",
  "node ",
  "perl ",
  "ruby ",
  "php ",
  "eval ",
  "exec ",
  "source ",
  ". ",
];

/**
 * Phrases like "run rm -rf" that explicitly request command execution.
 */
const DIRECT_EXECUTION_PHRASES: string[] = [
  "run ",
  "execute ",
  "exec ",
  "do ",
  "perform ",
  "launch ",
  "start ",
  "call ",
  "invoke ",
  "type ",
  "enter ",
  "paste ",
  "send ",
  "ssh ",
  "curl ",
  "wget ",
];

/**
 * Return `true` when the text looks like a direct command invocation.
 */
function looksLikeDirectCommand(text: string): boolean {
  // Starts with a known command verb
  for (const verb of DIRECT_COMMAND_VERBS) {
    if (text.startsWith(verb)) return true;
    if (text.includes(" " + verb)) return true;
    if (text.includes("\n" + verb)) return true;
  }

  // Contains explicit execution-request phrases
  for (const phrase of DIRECT_EXECUTION_PHRASES) {
    if (text.includes(phrase.toLowerCase())) return true;
  }

  return false;
}

/**
 * Convert a wildcard pattern (`*` = any chars) to a case-insensitive RegExp.
 */
function wildcardToRegex(pattern: string): RegExp {
  let escaped = "";
  for (const ch of pattern) {
    if (ch === "*") {
      escaped += ".*";
    } else if (ch === "?") {
      escaped += ".";
    } else {
      escaped += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(escaped, "i");
}
