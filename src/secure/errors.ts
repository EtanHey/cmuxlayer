// Security error classes for the secure MCP gateway

/**
 * Base security error. All security-related errors extend this class.
 */
export class SecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SecurityError";
  }
}

/**
 * Thrown when a tool call is denied by policy.
 */
export class ToolDeniedError extends SecurityError {
  readonly tool: string;
  readonly reason: string;

  constructor(tool: string, reason: string) {
    super("TOOL_DENIED", `Tool "${tool}" is denied: ${reason}`);
    this.tool = tool;
    this.reason = reason;
    this.name = "ToolDeniedError";
  }
}

/**
 * Thrown when a filesystem path is denied by policy.
 */
export class PathDeniedError extends SecurityError {
  readonly path: string;

  constructor(path: string) {
    super("PATH_DENIED", `Path "${path}" is denied by security policy`);
    this.path = path;
    this.name = "PathDeniedError";
  }
}

/**
 * Thrown when a tool requires human confirmation before execution.
 */
export class ConfirmationRequiredError extends SecurityError {
  readonly tool: string;

  constructor(tool: string) {
    super(
      "CONFIRMATION_REQUIRED",
      `Tool "${tool}" requires human confirmation before execution`,
    );
    this.tool = tool;
    this.name = "ConfirmationRequiredError";
  }
}

/**
 * Thrown when a command matches a denied pattern.
 */
export class CommandDeniedError extends SecurityError {
  readonly pattern: string;

  constructor(pattern: string) {
    super(
      "COMMAND_DENIED",
      `Command matches denied pattern: "${pattern}"`,
    );
    this.pattern = pattern;
    this.name = "CommandDeniedError";
  }
}

/**
 * Thrown when a policy YAML file cannot be loaded or parsed.
 */
export class PolicyLoadError extends SecurityError {
  readonly filepath: string;
  readonly causeError?: Error;

  constructor(filepath: string, message: string, causeError?: Error) {
    super("POLICY_LOAD_ERROR", `Failed to load policy from "${filepath}": ${message}`);
    this.filepath = filepath;
    this.causeError = causeError;
    this.name = "PolicyLoadError";
  }
}
