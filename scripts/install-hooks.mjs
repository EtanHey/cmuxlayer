#!/usr/bin/env node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const hookPath = resolve(repoRoot, ".git", "hooks", "pre-push");

const hook = `#!/bin/sh
set -eu

cd "$(git rev-parse --show-toplevel)"
exec bun run pre-pr
`;

await mkdir(dirname(hookPath), { recursive: true });
await writeFile(hookPath, hook, { encoding: "utf8", mode: 0o755 });
await chmod(hookPath, 0o755);

process.stdout.write(`Installed pre-push hook: ${hookPath}\n`);
