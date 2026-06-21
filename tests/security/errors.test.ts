import { describe, it, expect } from "vitest";
import {
  SecurityError,
  ToolDeniedError,
  PathDeniedError,
  ConfirmationRequiredError,
  CommandDeniedError,
  PolicyLoadError,
} from "../../src/secure/errors.js";

describe("errors", () => {
  describe("SecurityError", () => {
    it("should be an instance of Error", () => {
      const err = new SecurityError("TEST_CODE", "test message");
      expect(err).toBeInstanceOf(Error);
    });

    it("should have the correct code property", () => {
      const err = new SecurityError("TEST_CODE", "test message");
      expect(err.code).toBe("TEST_CODE");
    });

    it("should have the correct message", () => {
      const err = new SecurityError("TEST_CODE", "test message");
      expect(err.message).toBe("test message");
    });

    it("should have the correct name", () => {
      const err = new SecurityError("TEST_CODE", "test message");
      expect(err.name).toBe("SecurityError");
    });
  });

  describe("ToolDeniedError", () => {
    it("should be an instance of SecurityError", () => {
      const err = new ToolDeniedError("test.tool", "not allowed");
      expect(err).toBeInstanceOf(SecurityError);
    });

    it("should have the correct code", () => {
      const err = new ToolDeniedError("test.tool", "not allowed");
      expect(err.code).toBe("TOOL_DENIED");
    });

    it("should have the correct tool property", () => {
      const err = new ToolDeniedError("test.tool", "not allowed");
      expect(err.tool).toBe("test.tool");
    });

    it("should have the correct reason property", () => {
      const err = new ToolDeniedError("test.tool", "not allowed");
      expect(err.reason).toBe("not allowed");
    });

    it("should include tool name and reason in message", () => {
      const err = new ToolDeniedError("test.tool", "not allowed");
      expect(err.message).toContain("test.tool");
      expect(err.message).toContain("not allowed");
    });

    it("should have the correct name", () => {
      const err = new ToolDeniedError("test.tool", "not allowed");
      expect(err.name).toBe("ToolDeniedError");
    });
  });

  describe("PathDeniedError", () => {
    it("should be an instance of SecurityError", () => {
      const err = new PathDeniedError("/etc/passwd");
      expect(err).toBeInstanceOf(SecurityError);
    });

    it("should have the correct code", () => {
      const err = new PathDeniedError("/etc/passwd");
      expect(err.code).toBe("PATH_DENIED");
    });

    it("should have the correct path property", () => {
      const err = new PathDeniedError("/etc/passwd");
      expect(err.path).toBe("/etc/passwd");
    });

    it("should include the path in message", () => {
      const err = new PathDeniedError("/etc/passwd");
      expect(err.message).toContain("/etc/passwd");
    });

    it("should have the correct name", () => {
      const err = new PathDeniedError("/etc/passwd");
      expect(err.name).toBe("PathDeniedError");
    });
  });

  describe("ConfirmationRequiredError", () => {
    it("should be an instance of SecurityError", () => {
      const err = new ConfirmationRequiredError("dangerous.tool");
      expect(err).toBeInstanceOf(SecurityError);
    });

    it("should have the correct code", () => {
      const err = new ConfirmationRequiredError("dangerous.tool");
      expect(err.code).toBe("CONFIRMATION_REQUIRED");
    });

    it("should have the correct tool property", () => {
      const err = new ConfirmationRequiredError("dangerous.tool");
      expect(err.tool).toBe("dangerous.tool");
    });

    it("should include the tool name in message", () => {
      const err = new ConfirmationRequiredError("dangerous.tool");
      expect(err.message).toContain("dangerous.tool");
    });

    it("should have the correct name", () => {
      const err = new ConfirmationRequiredError("dangerous.tool");
      expect(err.name).toBe("ConfirmationRequiredError");
    });
  });

  describe("CommandDeniedError", () => {
    it("should be an instance of SecurityError", () => {
      const err = new CommandDeniedError("rm -rf /*");
      expect(err).toBeInstanceOf(SecurityError);
    });

    it("should have the correct code", () => {
      const err = new CommandDeniedError("rm -rf /*");
      expect(err.code).toBe("COMMAND_DENIED");
    });

    it("should have the correct pattern property", () => {
      const err = new CommandDeniedError("rm -rf /*");
      expect(err.pattern).toBe("rm -rf /*");
    });

    it("should include the pattern in message", () => {
      const err = new CommandDeniedError("rm -rf /*");
      expect(err.message).toContain("rm -rf /*");
    });

    it("should have the correct name", () => {
      const err = new CommandDeniedError("rm -rf /*");
      expect(err.name).toBe("CommandDeniedError");
    });
  });

  describe("PolicyLoadError", () => {
    it("should be an instance of SecurityError", () => {
      const err = new PolicyLoadError("/path/to/policy.yaml", "file not found");
      expect(err).toBeInstanceOf(SecurityError);
    });

    it("should have the correct code", () => {
      const err = new PolicyLoadError("/path/to/policy.yaml", "file not found");
      expect(err.code).toBe("POLICY_LOAD_ERROR");
    });

    it("should have the correct filepath property", () => {
      const err = new PolicyLoadError("/path/to/policy.yaml", "file not found");
      expect(err.filepath).toBe("/path/to/policy.yaml");
    });

    it("should include filepath and message in the error message", () => {
      const err = new PolicyLoadError("/path/to/policy.yaml", "file not found");
      expect(err.message).toContain("/path/to/policy.yaml");
      expect(err.message).toContain("file not found");
    });

    it("should store causeError when provided", () => {
      const cause = new Error("ENOENT");
      const err = new PolicyLoadError(
        "/path/to/policy.yaml",
        "file not found",
        cause,
      );
      expect(err.causeError).toBe(cause);
    });

    it("should have undefined causeError when not provided", () => {
      const err = new PolicyLoadError("/path/to/policy.yaml", "file not found");
      expect(err.causeError).toBeUndefined();
    });

    it("should have the correct name", () => {
      const err = new PolicyLoadError("/path/to/policy.yaml", "file not found");
      expect(err.name).toBe("PolicyLoadError");
    });
  });
});
