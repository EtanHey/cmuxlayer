import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { SecureToolContext } from "../secure/policy-schema.js";
import { assertReadableProjectPath, isDeniedPath } from "../secure/path-guard.js";
import { PathDeniedError } from "../secure/errors.js";

const execFileAsync = promisify(execFile);

export interface ProjectToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): ProjectToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function err(error: unknown, extra: Record<string, unknown> = {}): ProjectToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message, ...extra }),
      },
    ],
    isError: true,
  };
}

// ─────────────────────────────────────────────────────────────
// project.info
// ─────────────────────────────────────────────────────────────
export async function projectInfo(
  _args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const root = context.policy.project.root;

  let exists = false;
  let isGit = false;
  let branch: string | null = null;

  try {
    await access(root);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    try {
      const gitDir = join(root, ".git");
      await access(gitDir);
      isGit = true;
    } catch {
      isGit = false;
    }

    if (isGit) {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
          { timeout: 5000 },
        );
        branch = stdout.trim() || null;
      } catch {
        branch = null;
      }
    }
  }

  return ok({ root, exists, git: isGit, branch });
}

// ─────────────────────────────────────────────────────────────
// project.tree
// ─────────────────────────────────────────────────────────────
interface TreeEntry {
  name: string;
  type: "file" | "dir";
  path: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  "coverage",
  ".nyc_output",
]);

export async function projectTree(
  args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const root = context.policy.project.root;
  const params = args as Record<string, unknown>;
  const subPath = typeof params.path === "string" ? params.path : ".";
  const maxDepth = typeof params.max_depth === "number" ? params.max_depth : 3;

  const basePath = join(root, subPath);

  // Validate base path is inside project
  try {
    await assertReadableProjectPath(relative(root, basePath) || ".", context.policy);
  } catch (e) {
    return err(e);
  }

  const entries: TreeEntry[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }

    for (const name of items) {
      if (name.startsWith(".") && name !== ".github" && name !== ".vscode") {
        continue;
      }
      if (SKIP_DIRS.has(name)) continue;

      const fullPath = join(dir, name);
      const relPath = relative(root, fullPath);

      // Check deny list
      if (isDeniedPath(relPath, context.policy)) continue;

      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      const type = info.isDirectory() ? "dir" : "file";
      entries.push({ name, type, path: relPath });

      if (info.isDirectory() && depth < maxDepth) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(basePath, 0);

  return ok({ entries });
}

// ─────────────────────────────────────────────────────────────
// project.read_file
// ─────────────────────────────────────────────────────────────
export async function projectReadFile(
  args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const params = args as Record<string, unknown>;
  const inputPath = typeof params.path === "string" ? params.path : "";

  if (!inputPath) {
    return err("Missing required 'path' argument");
  }

  let resolvedPath: string;
  try {
    resolvedPath = await assertReadableProjectPath(inputPath, context.policy);
  } catch (e) {
    return err(e);
  }

  const maxBytes = context.policy.project.max_file_read_bytes;
  let content: string;
  let truncated = false;

  try {
    const fileContent = await readFile(resolvedPath, "utf8");
    if (Buffer.byteLength(fileContent, "utf8") > maxBytes) {
      // Truncate to byte limit safely
      let byteCount = 0;
      let charIndex = 0;
      for (const char of fileContent) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (byteCount + charBytes > maxBytes) {
          break;
        }
        byteCount += charBytes;
        charIndex += char.length;
      }
      content = fileContent.slice(0, charIndex) + "\n... [truncated: file exceeds max_file_read_bytes]";
      truncated = true;
    } else {
      content = fileContent;
    }
  } catch (e) {
    return err(e);
  }

  // Apply redaction
  const redactedContent = context.redactor.redact(content);

  return ok({ content: redactedContent, truncated });
}

// ─────────────────────────────────────────────────────────────
// project.search
// ─────────────────────────────────────────────────────────────
interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export async function projectSearch(
  args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const params = args as Record<string, unknown>;
  const query = typeof params.query === "string" ? params.query : "";
  const subPath = typeof params.path === "string" ? params.path : ".";

  if (!query) {
    return err("Missing required 'query' argument");
  }

  const root = context.policy.project.root;
  const searchRoot = join(root, subPath);
  const maxResults = context.policy.project.max_search_results;

  // Validate path
  try {
    await assertReadableProjectPath(relative(root, searchRoot) || ".", context.policy);
  } catch (e) {
    return err(e);
  }

  const matches: SearchMatch[] = [];

  // Try ripgrep first, fallback to fs scan
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--json", "-n", "-C", "1", "--max-count", String(maxResults), query, searchRoot],
      { timeout: 15000 },
    );

    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === "match") {
          const data = parsed.data as Record<string, unknown>;
          const pathData = data.path as Record<string, unknown>;
          const linesData = data.lines as Record<string, unknown>;
          const lineNum = (data.line_number as number) ?? 0;
          const filePath =
            typeof pathData.text === "string"
              ? relative(root, pathData.text)
              : "";
          const text =
            typeof linesData.text === "string"
              ? linesData.text
              : String(linesData.text ?? "");

          if (filePath && !isDeniedPath(filePath, context.policy)) {
            matches.push({ file: filePath, line: lineNum, text });
          }
        }
      } catch {
        // skip malformed rg output
      }
    }
  } catch {
    // Fallback: fs scan
    await searchFsFallback(root, searchRoot, query, maxResults, matches, context);
  }

  return ok({ matches: matches.slice(0, maxResults) });
}

async function searchFsFallback(
  root: string,
  searchRoot: string,
  query: string,
  maxResults: number,
  matches: SearchMatch[],
  context: SecureToolContext,
): Promise<void> {
  const lowerQuery = query.toLowerCase();

  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxResults) return;

    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }

    for (const name of items) {
      if (matches.length >= maxResults) return;
      if (name.startsWith(".")) continue;
      if (SKIP_DIRS.has(name)) continue;

      const fullPath = join(dir, name);
      const relPath = relative(root, fullPath);

      if (isDeniedPath(relPath, context.policy)) continue;

      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        await walk(fullPath);
      } else if (info.isFile() && info.size < 1024 * 1024) {
        try {
          const content = await readFile(fullPath, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              matches.push({
                file: relPath,
                line: i + 1,
                text: lines[i].trim(),
              });
              if (matches.length >= maxResults) return;
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(searchRoot);
}

// ─────────────────────────────────────────────────────────────
// project.grep
// ─────────────────────────────────────────────────────────────
export async function projectGrep(
  args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const params = args as Record<string, unknown>;
  const pattern = typeof params.pattern === "string" ? params.pattern : "";
  const subPath = typeof params.path === "string" ? params.path : ".";

  if (!pattern) {
    return err("Missing required 'pattern' argument");
  }

  const root = context.policy.project.root;
  const searchRoot = join(root, subPath);
  const maxResults = context.policy.project.max_search_results;

  // Validate path
  try {
    await assertReadableProjectPath(relative(root, searchRoot) || ".", context.policy);
  } catch (e) {
    return err(e);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return err(`Invalid regex pattern: ${pattern}`);
  }

  const matches: SearchMatch[] = [];

  // Try ripgrep first
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--json", "-n", "-C", "1", "--max-count", String(maxResults), "-e", pattern, searchRoot],
      { timeout: 15000 },
    );

    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === "match") {
          const data = parsed.data as Record<string, unknown>;
          const pathData = data.path as Record<string, unknown>;
          const linesData = data.lines as Record<string, unknown>;
          const lineNum = (data.line_number as number) ?? 0;
          const filePath =
            typeof pathData.text === "string"
              ? relative(root, pathData.text)
              : "";
          const text =
            typeof linesData.text === "string"
              ? linesData.text
              : String(linesData.text ?? "");

          if (filePath && !isDeniedPath(filePath, context.policy)) {
            matches.push({ file: filePath, line: lineNum, text });
          }
        }
      } catch {
        // skip malformed rg output
      }
    }
  } catch {
    // Fallback: fs scan with regex
    await grepFsFallback(root, searchRoot, regex, maxResults, matches, context);
  }

  return ok({ matches: matches.slice(0, maxResults) });
}

async function grepFsFallback(
  root: string,
  searchRoot: string,
  regex: RegExp,
  maxResults: number,
  matches: SearchMatch[],
  context: SecureToolContext,
): Promise<void> {
  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxResults) return;

    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }

    for (const name of items) {
      if (matches.length >= maxResults) return;
      if (name.startsWith(".")) continue;
      if (SKIP_DIRS.has(name)) continue;

      const fullPath = join(dir, name);
      const relPath = relative(root, fullPath);

      if (isDeniedPath(relPath, context.policy)) continue;

      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        await walk(fullPath);
      } else if (info.isFile() && info.size < 1024 * 1024) {
        try {
          const content = await readFile(fullPath, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({
                file: relPath,
                line: i + 1,
                text: lines[i].trim(),
              });
              if (matches.length >= maxResults) return;
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(searchRoot);
}

// ─────────────────────────────────────────────────────────────
// project.git_status
// ─────────────────────────────────────────────────────────────
interface GitChange {
  status: string;
  file: string;
}

export async function projectGitStatus(
  _args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const root = context.policy.project.root;

  let branch = "";
  let clean = true;
  const changes: GitChange[] = [];

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "status", "--short", "--branch"],
      { timeout: 10000 },
    );

    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      // Branch line: ## branch.name
      if (line.startsWith("##")) {
        const match = line.match(/^##\s+(\S+)/);
        if (match) {
          branch = match[1]!;
        }
        continue;
      }

      // Status line: XY filename  or  XY filename -> newname
      const match = line.match(/^(.{2})\s+(.+)$/);
      if (match) {
        const statusCode = match[1]!.trim();
        const file = match[2]!;
        if (statusCode) {
          clean = false;
          changes.push({ status: statusCode, file });
        }
      }
    }

    return ok({ branch, clean, changes });
  } catch (e) {
    return err(e);
  }
}

// ─────────────────────────────────────────────────────────────
// project.git_diff
// ─────────────────────────────────────────────────────────────
export async function projectGitDiff(
  args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const params = args as Record<string, unknown>;
  const filePath = typeof params.path === "string" ? params.path : undefined;
  const root = context.policy.project.root;

  try {
    const gitArgs = filePath
      ? ["-C", root, "diff", "--stat", "--", filePath]
      : ["-C", root, "diff", "--stat"];

    const { stdout: statOutput } = await execFileAsync("git", gitArgs, {
      timeout: 10000,
    });

    if (filePath) {
      // Also get actual diff for a specific file
      try {
        const { stdout: diffOutput } = await execFileAsync(
          "git",
          ["-C", root, "diff", "--", filePath],
          { timeout: 10000 },
        );
        return ok({ stat: statOutput.trim(), diff: diffOutput.trim() });
      } catch {
        return ok({ stat: statOutput.trim() });
      }
    }

    return ok({ stat: statOutput.trim() });
  } catch (e) {
    return err(e);
  }
}

// ─────────────────────────────────────────────────────────────
// project.git_log_recent
// ─────────────────────────────────────────────────────────────
interface GitCommit {
  hash: string;
  message: string;
  date: string;
}

export async function projectGitLogRecent(
  args: unknown,
  context: SecureToolContext,
): Promise<ProjectToolResult> {
  const params = args as Record<string, unknown>;
  const n = typeof params.n === "number" ? params.n : 10;
  const root = context.policy.project.root;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "log", "--oneline", "--format=%H|%s|%ci", `-n${n}`],
      { timeout: 10000 },
    );

    const commits: GitCommit[] = [];
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length >= 3) {
        commits.push({
          hash: parts[0]!,
          message: parts[1]!,
          date: parts[2]!,
        });
      }
    }

    return ok({ commits });
  } catch (e) {
    return err(e);
  }
}
