import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..");
const scratch = join(repo, "docs.local", "scratch", "i3");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "build-commit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(command: string, args: string[], cwd = repo): string {
  return execFileSync(command, args, {
    cwd, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, CMUXLAYER_CONFIG_FILE: join(root, "no-config") },
  }).trim();
}

describe("build commit identity", () => {
  it("reports null from an unstamped checkout and preserves text --version", () => {
    const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const args = ["--import", "tsx", "src/index.ts", "--version"];
    expect(run(process.execPath, args)).toBe(`cmuxlayer ${version}`);
    expect(JSON.parse(run(process.execPath, [...args, "--json"]))).toEqual({
      version, commit: null,
    });
  });

  it("ships the peeled annotated-tag commit through a git-free archive build", () => {
    const source = join(root, "source");
    const installed = join(root, "libexec");
    mkdirSync(source);
    mkdirSync(installed);
    for (const file of ["src", "package.json", "tsconfig.json", ".gitattributes"]) {
      cpSync(join(repo, file), join(source, file), { recursive: true });
    }
    const git = (...args: string[]) => run("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "user.name=Build fixture",
      "-c", "user.email=fixture@example.invalid", ...args,
    ], source);
    git("init", "-q");
    git("add", ".");
    git("-c", "commit.gpgSign=false", "commit", "-qm", "release fixture");
    git("-c", "tag.gpgSign=false", "tag", "-a", "v1.0.0", "-m", "release fixture");
    const commit = git("rev-parse", "v1.0.0^{commit}");
    expect(git("rev-parse", "v1.0.0")).not.toBe(commit);
    const archive = join(root, "source.tar");
    git("archive", "--format=tar", "-o", archive, "v1.0.0");
    run("tar", ["-xf", archive, "-C", installed]);
    expect(existsSync(join(installed, ".git"))).toBe(false);
    symlinkSync(join(repo, "node_modules"), join(installed, "node_modules"), "dir");
    run("bun", ["run", "build"], installed);
    // Homebrew retains only dist/, package.json and node_modules for this CLI.
    rmSync(join(installed, "src"), { recursive: true });
    const args = ["dist/index.js", "--version", "--json"];
    const report = JSON.parse(run(process.execPath, args, installed));
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report).toEqual({
      version: JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version,
      commit,
    });
    // A corrupt or absent stamp must not turn into a guessed commit.
    const versionJs = join(installed, "dist", "version.js");
    const compiled = readFileSync(versionJs, "utf8");
    for (const stamp of ["", "bad-commit"]) {
      writeFileSync(versionJs, compiled.replace(commit, stamp));
      expect(JSON.parse(run(process.execPath, args, installed)).commit).toBeNull();
    }
  });
});
