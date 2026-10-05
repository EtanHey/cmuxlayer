import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([false, true])("clears git-local environment before the hook suite (queued=%s)", (queued) => {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-prepush-env-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
    const names = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).stdout.trim().split("\n");
    for (const name of names) delete env[name];
    expect(spawnSync("git", ["init", root], { env }).status).toBe(0);
    mkdirSync(join(root, "scripts"));
    copyFileSync(resolve(__dirname, "../.githooks/pre-push"), join(root, "pre-push"));
    writeFileSync(join(root, "scripts/run_tests.sh"), 'printf "%s|%s|%s\\n" "${GIT_DIR-unset}" "${GIT_WORK_TREE-unset}" "${GIT_INDEX_FILE-unset}"\n');
    if (queued) {
      const helperDir = join(root, "Gits/golems/scripts/hooks");
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(join(helperDir, "heavy-suite.py"), "import os, sys\nos.execvp(sys.argv[2], sys.argv[2:])\n");
    }
    const result = spawnSync("bash", [join(root, "pre-push")], {
      cwd: root, encoding: "utf8",
      env: { ...env, GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root, GIT_INDEX_FILE: join(root, ".git/index") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unset|unset|unset");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
