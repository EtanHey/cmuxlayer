import { describe, it, expect } from "vitest";
import { buildTitle, replaceTaskSuffix, extractPrefix } from "../src/naming.js";

describe("buildTitle", () => {
  it("returns launcher label alone when no task", () => {
    expect(buildTitle("orcClaude")).toBe("orcClaude");
  });

  it("combines launcher and task with colon separator", () => {
    expect(buildTitle("orcClaude", "build-api")).toBe("orcClaude: build-api");
  });

  it("trims whitespace from inputs", () => {
    expect(buildTitle("  orcClaude  ", "  build  ")).toBe("orcClaude: build");
  });

  it("ignores empty task name", () => {
    expect(buildTitle("orcClaude", "")).toBe("orcClaude");
    expect(buildTitle("orcClaude", "  ")).toBe("orcClaude");
  });
});

describe("replaceTaskSuffix", () => {
  it("replaces suffix after colon", () => {
    expect(replaceTaskSuffix("orcClaude: old-task", "new-task")).toBe(
      "orcClaude: new-task",
    );
  });

  it("appends suffix when no colon exists", () => {
    expect(replaceTaskSuffix("orcClaude", "build")).toBe("orcClaude: build");
  });

  it("preserves launcher prefix with multiple colons", () => {
    expect(replaceTaskSuffix("orc: sub: deep", "new")).toBe("orc: new");
  });

  it("handles empty new suffix by returning just the prefix", () => {
    expect(replaceTaskSuffix("orcClaude: task", "")).toBe("orcClaude");
  });

  it("uses the suffix alone when the current title has no prefix", () => {
    expect(replaceTaskSuffix("", "build")).toBe("build");
    expect(replaceTaskSuffix("   ", "build")).toBe("build");
  });
});

describe("extractPrefix", () => {
  it("extracts prefix before colon", () => {
    expect(extractPrefix("orcClaude: task")).toBe("orcClaude");
  });

  it("returns full title when no colon", () => {
    expect(extractPrefix("orcClaude")).toBe("orcClaude");
  });

  it("trims whitespace from result", () => {
    expect(extractPrefix("  orcClaude  : task")).toBe("orcClaude");
  });
});
