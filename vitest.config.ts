import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/vitest.setup.ts"],
  },
});
