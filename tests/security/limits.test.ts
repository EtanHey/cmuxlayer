import { describe, it, expect } from "vitest";
import {
  truncateOutput,
  hashInput,
  createRequestId,
} from "../../src/secure/limits.js";

describe("limits", () => {
  describe("truncateOutput", () => {
    it("should return empty string for empty input", () => {
      const result = truncateOutput("", 100, 1000);
      expect(result).toBe("");
    });

    it("should return unchanged text within limits", () => {
      const input = "line1\nline2\nline3";
      const result = truncateOutput(input, 100, 1000);
      expect(result).toBe(input);
    });

    it("should truncate to max chars", () => {
      const input = "a".repeat(200);
      const result = truncateOutput(input, 500, 100);
      expect(result.length).toBeLessThanOrEqual(200); // includes truncation notice
      expect(result).toContain("... truncated");
    });

    it("should truncate to max lines", () => {
      const input = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateOutput(input, 5, 10000);
      const lines = result.split("\n");
      // Result has 5 kept lines plus truncation notice line = 6
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(result).toContain("... truncated");
    });

    it("should add truncation notice when truncated by chars", () => {
      const input = "x".repeat(500);
      const result = truncateOutput(input, 100, 100);
      expect(result).toContain("... truncated");
      expect(result).toMatch(/\d+ lines?, \d+ chars? omitted/);
    });

    it("should add truncation notice when truncated by lines", () => {
      const input = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateOutput(input, 10, 100_000);
      expect(result).toContain("... truncated");
      expect(result).toMatch(/\d+ lines?, \d+ chars? omitted/);
    });

    it("should truncate at last newline when possible", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
      const input = lines.join("\n");
      // maxChars set to cut somewhere in the middle
      const result = truncateOutput(input, 500, 30);
      // Should end at a newline boundary when the last newline is within 80% of maxChars
      expect(result).toContain("... truncated");
    });

    it("should handle single line that exceeds char limit", () => {
      const input = "x".repeat(1000);
      const result = truncateOutput(input, 10, 50);
      expect(result).toContain("... truncated");
      expect(result.length).toBeLessThan(1000);
    });

    it("should handle text at exactly the line limit", () => {
      const input = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateOutput(input, 10, 10_000);
      expect(result).toBe(input);
    });

    it("should handle text at exactly the char limit", () => {
      const input = "x".repeat(100);
      const result = truncateOutput(input, 100, 100);
      expect(result).toBe(input);
    });

    it("should not include truncation notice when text is not truncated", () => {
      const input = "short text";
      const result = truncateOutput(input, 100, 1000);
      expect(result).not.toContain("... truncated");
    });
  });

  describe("hashInput", () => {
    it("should return a 64-character hex string", () => {
      const result = hashInput("test");
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it("should be deterministic for same input", () => {
      const input = "test input string";
      const hash1 = hashInput(input);
      const hash2 = hashInput(input);
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = hashInput("input one");
      const hash2 = hashInput("input two");
      expect(hash1).not.toBe(hash2);
    });

    it("should handle empty string", () => {
      const result = hashInput("");
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it("should handle unicode input", () => {
      const result = hashInput("Hello 🌍 世界");
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it("should handle long input", () => {
      const input = "x".repeat(1_000_000);
      const result = hashInput(input);
      expect(result).toHaveLength(64);
    });

    it("should produce the expected SHA-256 hash for known input", () => {
      // SHA-256 of "hello" is known
      const result = hashInput("hello");
      expect(result).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    });
  });

  describe("createRequestId", () => {
    it("should return a string starting with req_", () => {
      const result = createRequestId();
      expect(result.startsWith("req_")).toBe(true);
    });

    it("should return a non-empty string", () => {
      const result = createRequestId();
      expect(result.length).toBeGreaterThan(4);
    });

    it("should return unique ids on successive calls", () => {
      const id1 = createRequestId();
      const id2 = createRequestId();
      expect(id1).not.toBe(id2);
    });

    it("should include a timestamp after req_ prefix", () => {
      const result = createRequestId();
      const parts = result.split("_");
      expect(parts.length).toBe(3);
      // parts[1] should be the timestamp
      const timestamp = parseInt(parts[1], 10);
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    });

    it("should include a random hex suffix", () => {
      const result = createRequestId();
      const parts = result.split("_");
      // parts[2] should be random hex (8 bytes = 16 hex chars)
      expect(parts[2]).toMatch(/^[0-9a-f]+$/);
      expect(parts[2].length).toBeGreaterThanOrEqual(8);
    });
  });
});
