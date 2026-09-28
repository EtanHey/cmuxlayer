import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RAISE_NOFILE_SOFT_LIMIT } from "../src/nofile-limit.js";

describe("agent CLI nofile setup docs", () => {
  it("documents the exact daemon-tested nofile snippet", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const section = readme.match(/## Raise the open-files limit for agent CLIs\n([\s\S]*?)(?=\n## |$)/)?.[1];
    expect(section).toBeDefined();
    const snippet = section?.match(/```sh\n([^\n]+)\n```/)?.[1];
    expect(snippet).toBe(RAISE_NOFILE_SOFT_LIMIT);
  });
});
