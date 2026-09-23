import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/repro/issue-632-on-task-update.repro.ts"],
  },
});
