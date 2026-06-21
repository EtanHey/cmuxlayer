import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandHomeDir,
  validatePolicy,
  loadPolicySync,
  parseYaml,
} from "../../src/secure/policy.js";
import { PolicyLoadError } from "../../src/secure/errors.js";
import type { Policy } from "../../src/secure/policy-schema.js";

describe("policy", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cmux-policy-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("expandHomeDir", () => {
    it("should expand ~ to home directory", () => {
      const result = expandHomeDir("~");
      expect(result).not.toBe("~");
      expect(result).toBeTruthy();
    });

    it("should expand ~/path to absolute path inside home", () => {
      const result = expandHomeDir("~/.config");
      expect(result.startsWith("/")).toBe(true);
      expect(result.endsWith("/.config")).toBe(true);
      expect(result).not.toContain("~");
    });

    it("should leave absolute paths unchanged", () => {
      const result = expandHomeDir("/absolute/path");
      expect(result).toBe("/absolute/path");
    });

    it("should leave relative paths unchanged", () => {
      const result = expandHomeDir("relative/path");
      expect(result).toBe("relative/path");
    });
  });

  describe("parseYaml", () => {
    it("should parse a simple key-value document", () => {
      const yaml = "name: test\nvalue: 42";
      const result = parseYaml(yaml) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.value).toBe(42);
    });

    it("should parse nested objects", () => {
      const yaml = "project:\n  root: /tmp/test\n  max_file_read_bytes: 5000";
      const result = parseYaml(yaml) as Record<string, unknown>;
      expect(result.project).toBeDefined();
      const project = result.project as Record<string, unknown>;
      expect(project.root).toBe("/tmp/test");
      expect(project.max_file_read_bytes).toBe(5000);
    });

    it("should parse arrays", () => {
      const yaml = "items:\n  - one\n  - two\n  - three";
      const result = parseYaml(yaml) as Record<string, unknown>;
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toEqual(["one", "two", "three"]);
    });

    it("should parse inline arrays", () => {
      const yaml = "deny: [.env, *.pem, node_modules/**]";
      const result = parseYaml(yaml) as Record<string, unknown>;
      expect(Array.isArray(result.deny)).toBe(true);
      expect(result.deny).toEqual([".env", "*.pem", "node_modules/**"]);
    });

    it("should ignore comments", () => {
      const yaml = "name: test # this is a comment\n# ignored line\nvalue: 42";
      const result = parseYaml(yaml) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.value).toBe(42);
    });
  });

  describe("validatePolicy", () => {
    it("should return a valid Policy for a complete object", () => {
      const raw = {
        project: {
          root: "/tmp/test-project",
          max_file_read_bytes: 10000,
          max_search_results: 50,
          deny: [".env", "*.pem"],
        },
        tools: {
          allow: ["project.*", "system.*"],
          require_confirmation: ["shell.*"],
          deny: ["fs.write*"],
        },
      };

      const policy = validatePolicy(raw);
      expect(policy.project.root).toBe("/tmp/test-project");
      expect(policy.project.deny).toEqual([".env", "*.pem"]);
      expect(policy.tools.allow).toEqual(["project.*", "system.*"]);
    });

    it("should throw PolicyLoadError for an invalid object", () => {
      const raw = { invalid: true };
      expect(() => validatePolicy(raw)).toThrow(PolicyLoadError);
    });

    it("should throw PolicyLoadError with helpful message for invalid object", () => {
      const raw = { invalid: true };
      expect(() => validatePolicy(raw)).toThrow(/Schema validation failed/);
    });

    it("should apply defaults for optional sections", () => {
      const raw = {
        project: {
          root: "/tmp/test",
          max_file_read_bytes: 5000,
          max_search_results: 50,
          deny: [],
        },
        tools: {
          allow: [],
          require_confirmation: [],
          deny: [],
        },
      };

      const policy = validatePolicy(raw);
      expect(policy.workspaces).toBeUndefined();
      expect(policy.agents).toBeUndefined();
      expect(policy.commands).toBeUndefined();
      expect(policy.audit).toBeUndefined();
      expect(policy.limits).toBeUndefined();
    });
  });

  describe("loadPolicySync", () => {
    it("should read and parse a valid YAML policy file", () => {
      const yaml = `
project:
  root: /tmp/test-project
  max_file_read_bytes: 10000
  max_search_results: 50
  deny:
    - .env
    - .env.*
    - "*.pem"
    - node_modules/**
tools:
  allow:
    - "project.*"
    - "system.*"
  require_confirmation:
    - "cmux.send_text"
  deny:
    - "shell.exec"
`;
      const filePath = join(tempDir, "policy.yaml");
      writeFileSync(filePath, yaml, "utf-8");

      const policy = loadPolicySync(filePath);
      expect(policy.project.root).toBe("/tmp/test-project");
      expect(policy.project.max_file_read_bytes).toBe(10000);
      expect(policy.project.deny).toEqual([
        ".env",
        ".env.*",
        "*.pem",
        "node_modules/**",
      ]);
      expect(policy.tools.allow).toEqual(["project.*", "system.*"]);
      expect(policy.tools.require_confirmation).toEqual(["cmux.send_text"]);
      expect(policy.tools.deny).toEqual(["shell.exec"]);
    });

    it("should expand ~ in project.root", () => {
      const yaml = `
project:
  root: ~/my-project
  deny: []
tools:
  allow: []
  require_confirmation: []
  deny: []
`;
      const filePath = join(tempDir, "policy-home.yaml");
      writeFileSync(filePath, yaml, "utf-8");

      const policy = loadPolicySync(filePath);
      expect(policy.project.root.startsWith("/")).toBe(true);
      expect(policy.project.root).not.toContain("~");
    });

    it("should throw PolicyLoadError for a missing file", () => {
      const filePath = join(tempDir, "nonexistent.yaml");
      expect(() => loadPolicySync(filePath)).toThrow(PolicyLoadError);
    });

    it("should apply default values for missing optional sections", () => {
      const yaml = `
project:
  root: /tmp/minimal
  deny: []
tools:
  allow: []
  require_confirmation: []
  deny: []
`;
      const filePath = join(tempDir, "minimal-policy.yaml");
      writeFileSync(filePath, yaml, "utf-8");

      const policy = loadPolicySync(filePath);
      expect(policy.project.max_file_read_bytes).toBe(200_000);
      expect(policy.project.max_search_results).toBe(100);
      expect(policy.tools.allow).toEqual([]);
      expect(policy.tools.require_confirmation).toEqual([]);
      expect(policy.tools.deny).toEqual([]);
    });

    it("should handle boolean and numeric values correctly", () => {
      const yaml = `
project:
  root: /tmp/test
  deny: []
tools:
  allow: []
  require_confirmation: []
  deny: []
audit:
  redact_secrets: false
  log_full_inputs: true
  log_input_preview_chars: 500
limits:
  max_output_lines: 1000
  max_screen_chars: 100000
  max_request_body_bytes: 500000
  tool_timeout_ms: 60000
  max_concurrent_requests: 10
`;
      const filePath = join(tempDir, "full-policy.yaml");
      writeFileSync(filePath, yaml, "utf-8");

      const policy = loadPolicySync(filePath);
      expect(policy.audit).toBeDefined();
      expect(policy.audit?.redact_secrets).toBe(false);
      expect(policy.audit?.log_full_inputs).toBe(true);
      expect(policy.audit?.log_input_preview_chars).toBe(500);
      expect(policy.limits).toBeDefined();
      expect(policy.limits?.max_output_lines).toBe(1000);
      expect(policy.limits?.max_screen_chars).toBe(100_000);
      expect(policy.limits?.tool_timeout_ms).toBe(60_000);
      expect(policy.limits?.max_concurrent_requests).toBe(10);
    });
  });
});
