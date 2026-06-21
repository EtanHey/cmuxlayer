import { describe, it, expect } from "vitest";
import {
  resolveInsideProject,
  isDeniedPath,
  matchesGlob,
  assertReadableProjectPath,
} from "../../src/secure/path-guard.js";
import { PathDeniedError } from "../../src/secure/errors.js";
import type { Policy } from "../../src/secure/policy-schema.js";

const testPolicy: Policy = {
  project: {
    root: "/tmp/test-project",
    max_file_read_bytes: 10000,
    max_search_results: 50,
    deny: [".env", ".env.*", "*.pem", "node_modules/**"],
  },
  tools: {
    allow: ["project.*", "system.*"],
    require_confirmation: [],
    deny: [],
  },
};

describe("path-guard", () => {
  describe("resolveInsideProject", () => {
    it("should resolve a relative path inside the project", async () => {
      const result = await resolveInsideProject("README.md", testPolicy);
      expect(result).toBe("/tmp/test-project/README.md");
    });

    it("should resolve a nested relative path inside the project", async () => {
      const result = await resolveInsideProject("src/index.ts", testPolicy);
      expect(result).toBe("/tmp/test-project/src/index.ts");
    });

    it("should reject home directory references", async () => {
      await expect(resolveInsideProject("~/.ssh/id_rsa", testPolicy)).rejects.toThrow(
        PathDeniedError,
      );
    });

    it("should reject directory traversal outside project", async () => {
      await expect(resolveInsideProject("../../etc/passwd", testPolicy)).rejects.toThrow(
        PathDeniedError,
      );
    });

    it("should reject absolute paths outside project root", async () => {
      await expect(resolveInsideProject("/etc/passwd", testPolicy)).rejects.toThrow(
        PathDeniedError,
      );
    });

    it("should allow absolute paths inside project root", async () => {
      const result = await resolveInsideProject("/tmp/test-project/src/file.ts", testPolicy);
      expect(result).toBe("/tmp/test-project/src/file.ts");
    });
  });

  describe("isDeniedPath", () => {
    it("should return true for .env (always denied)", () => {
      const result = isDeniedPath("/tmp/test-project/.env", testPolicy);
      expect(result).toBe(true);
    });

    it("should return false for allowed paths like src/index.ts", () => {
      const result = isDeniedPath("/tmp/test-project/src/index.ts", testPolicy);
      expect(result).toBe(false);
    });

    it("should return true for .env.local via always-denied basename", () => {
      const result = isDeniedPath("/tmp/test-project/.env.local", testPolicy);
      expect(result).toBe(true);
    });

    it("should return true for PEM files matching *.pem pattern", () => {
      const result = isDeniedPath("/tmp/test-project/id_rsa.pem", testPolicy);
      expect(result).toBe(true);
    });

    it("should return false for paths not matching any deny pattern", () => {
      const result = isDeniedPath("/tmp/test-project/src/utils/helper.ts", testPolicy);
      expect(result).toBe(false);
    });

    it("should always deny well-known sensitive env files regardless of policy", () => {
      const minimalPolicy: Policy = {
        project: {
          root: "/tmp/test-project",
          max_file_read_bytes: 10000,
          max_search_results: 50,
          deny: [],
        },
        tools: { allow: [], require_confirmation: [], deny: [] },
      };
      expect(isDeniedPath("/tmp/test-project/.env", minimalPolicy)).toBe(true);
      expect(isDeniedPath("/tmp/test-project/.env.local", minimalPolicy)).toBe(true);
      expect(isDeniedPath("/tmp/test-project/.env.production", minimalPolicy)).toBe(true);
    });
  });

  describe("matchesGlob", () => {
    it("should match *.txt against readme.txt", () => {
      expect(matchesGlob("readme.txt", "*.txt")).toBe(true);
    });

    it("should not match *.txt against file.js", () => {
      expect(matchesGlob("file.js", "*.txt")).toBe(false);
    });

    it("should match src/app.js against src/*.js", () => {
      expect(matchesGlob("src/app.js", "src/*.js")).toBe(true);
    });

    it("should not match src/nested/app.js against src/*.js", () => {
      expect(matchesGlob("src/nested/app.js", "src/*.js")).toBe(false);
    });

    it("should match foo/bar against foo/**", () => {
      expect(matchesGlob("foo/bar", "foo/**")).toBe(true);
    });

    it("should match foo/bar/baz against foo/**", () => {
      expect(matchesGlob("foo/bar/baz", "foo/**")).toBe(true);
    });

    it("should match against basename only when pattern has no slash", () => {
      expect(matchesGlob("/tmp/test/readme.txt", "*.txt")).toBe(true);
      expect(matchesGlob("/tmp/test/app.js", "*.txt")).toBe(false);
    });

    it("should not match src/app.js against foo/**", () => {
      expect(matchesGlob("src/app.js", "foo/**")).toBe(false);
    });

    it("should handle ** matching zero parts", () => {
      expect(matchesGlob("foo", "foo/**")).toBe(true);
    });
  });

  describe("assertReadableProjectPath", () => {
    it("should return resolved path for allowed readable files", async () => {
      const result = await assertReadableProjectPath("README.md", testPolicy);
      expect(result).toBe("/tmp/test-project/README.md");
    });

    it("should return resolved path for allowed source files", async () => {
      const result = await assertReadableProjectPath("src/index.ts", testPolicy);
      expect(result).toBe("/tmp/test-project/src/index.ts");
    });

    it("should throw PathDeniedError for directory traversal outside project", async () => {
      await expect(
        assertReadableProjectPath("../../.ssh/id_rsa", testPolicy),
      ).rejects.toThrow(PathDeniedError);
    });

    it("should throw PathDeniedError for denied paths like .env", async () => {
      await expect(
        assertReadableProjectPath(".env", testPolicy),
      ).rejects.toThrow(PathDeniedError);
    });

    it("should throw PathDeniedError for denied PEM files", async () => {
      await expect(
        assertReadableProjectPath("secrets/id_rsa.pem", testPolicy),
      ).rejects.toThrow(PathDeniedError);
    });

    it("should throw PathDeniedError for home directory references", async () => {
      await expect(
        assertReadableProjectPath("~/.bashrc", testPolicy),
      ).rejects.toThrow(PathDeniedError);
    });
  });
});
