/**
 * Terminal wiring for `cmuxlayer init`. The wizard itself
 * (`src/init-wizard.ts`) is pure and injectable; this file is the only part
 * that touches stdin, stdout, and the filesystem.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { runInitCommand, type InitEnvironment } from "./init-wizard.js";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function realInitEnvironment(): InitEnvironment {
  return {
    homeDir: process.env.HOME?.trim() || homedir(),
    env: process.env,
    isDirectory,
    fileExists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * AIDEV-NOTE: `readline.question()` never resolves once stdin has ended, so a
 * piped or redirected stdin used to leave the wizard hanging on its next
 * question and the process exiting 0 having written nothing — a silent
 * no-op that reads as success. Input ending is now an error that names the
 * non-interactive flag instead.
 */
class StdinEndedError extends Error {
  constructor() {
    super(
      "Input ended before setup finished. For a scripted install use: " +
        "cmuxlayer init --yes --repo <name>=<path>",
    );
  }
}

export async function runInitCli(argv: readonly string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let stdinEnded = false;
  rl.on("close", () => {
    stdinEnded = true;
  });
  try {
    return await runInitCommand(
      argv,
      {
        question: async (prompt) => {
          if (stdinEnded) throw new StdinEndedError();
          return await Promise.race([
            rl.question(prompt),
            new Promise<never>((_, reject) => {
              rl.once("close", () => reject(new StdinEndedError()));
            }),
          ]);
        },
        write: (text) => process.stdout.write(text),
        writeError: (text) => process.stderr.write(text),
      },
      realInitEnvironment(),
      async (path, contents) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, { encoding: "utf8", mode: 0o644 });
      },
    );
  } finally {
    rl.close();
  }
}
