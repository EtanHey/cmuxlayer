import { describe, it, expect } from "vitest";
import { createDefaultRedactor } from "../../src/secure/redactor.js";

describe("redactor", () => {
  describe("createDefaultRedactor", () => {
    it("should create a redactor with redact method", () => {
      const redactor = createDefaultRedactor();
      expect(typeof redactor.redact).toBe("function");
    });

    it("should create a redactor with addPattern method", () => {
      const redactor = createDefaultRedactor();
      expect(typeof redactor.addPattern).toBe("function");
    });
  });

  describe("OpenAI API key redaction", () => {
    it("should redact sk- prefixed API keys", () => {
      const redactor = createDefaultRedactor();
      const input = "sk-abc123xyz789foo456bar789baz012";
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET]");
    });

    it("should redact long OpenAI API keys", () => {
      const redactor = createDefaultRedactor();
      const key = "sk-" + "a".repeat(48);
      const result = redactor.redact(key);
      expect(result).toBe("[REDACTED_SECRET]");
    });

    it("should not redact short sk- strings", () => {
      const redactor = createDefaultRedactor();
      const input = "sk-short";
      const result = redactor.redact(input);
      expect(result).toBe("sk-short");
    });
  });

  describe("GitHub PAT redaction", () => {
    it("should redact classic GitHub PATs (ghp_)", () => {
      const redactor = createDefaultRedactor();
      const input = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET]");
    });

    it("should redact fine-grained GitHub PATs (github_pat_)", () => {
      const redactor = createDefaultRedactor();
      const input = "github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET]");
    });
  });

  describe("Environment variable assignment redaction", () => {
    it("should redact OPENAI_API_KEY=sk-...", () => {
      const redactor = createDefaultRedactor();
      const input = "OPENAI_API_KEY=sk-proj-test1234567890abcdef";
      const result = redactor.redact(input);
      expect(result).toBe("OPENAI_API_KEY=[REDACTED_SECRET]");
    });

    it("should redact ANTHROPIC_API_KEY=...", () => {
      const redactor = createDefaultRedactor();
      const input = "ANTHROPIC_API_KEY=sk-ant-xxxxx";
      const result = redactor.redact(input);
      expect(result).toBe("ANTHROPIC_API_KEY=[REDACTED_SECRET]");
    });

    it("should redact DEEPSEEK_API_KEY=...", () => {
      const redactor = createDefaultRedactor();
      const input = "DEEPSEEK_API_KEY=ds-key-12345";
      const result = redactor.redact(input);
      expect(result).toBe("DEEPSEEK_API_KEY=[REDACTED_SECRET]");
    });

    it("should redact SUPABASE_SERVICE_ROLE_KEY=...", () => {
      const redactor = createDefaultRedactor();
      const input = "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs";
      const result = redactor.redact(input);
      expect(result).toBe("SUPABASE_SERVICE_ROLE_KEY=[REDACTED_SECRET]");
    });

    it("should redact AWS_SECRET_ACCESS_KEY=...", () => {
      const redactor = createDefaultRedactor();
      const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const result = redactor.redact(input);
      expect(result).toBe("AWS_SECRET_ACCESS_KEY=[REDACTED_SECRET]");
    });
  });

  describe("Private key block redaction", () => {
    it("should redact RSA private key blocks", () => {
      const redactor = createDefaultRedactor();
      const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MqK8k7f5z3h4j8wQ
AQEFFwFQVp7c/m++r7bRxG4rBb7zZdd8np0j6vZHh8a4W6RXR8tXp3X7Vs1Z7Zz8
-----END RSA PRIVATE KEY-----`;
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET]");
    });

    it("should redact OPENSSH private key blocks", () => {
      const redactor = createDefaultRedactor();
      const input = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBz0bGJMK0zNPoKhunL2wK6B4xP6wZ6lNVeLjIF2c9tHAAAAJQI2GYZCNhm
GQAAAAtzc2gtZWQyNTUxOQAAACBz0bGJMK0zNPoKhunL2wK6B4xP6wZ6lNVeLjIF2c9t
-----END OPENSSH PRIVATE KEY-----`;
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET]");
    });

    it("should redact EC private key blocks", () => {
      const redactor = createDefaultRedactor();
      const input = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIB/SiOxa6QmdbS/Zlh6QF4uRL2iIB+CWHh3Ru8G8GyguoAcGBSuBBAAK
oUQDQgAExzKx7J2l4z9jWq3Z3Y5Z6Z7Z8Z9Z0Z1Z2Z3Z4Z5Z6Z7Z8Z9Z0Z1Z2Z3Z4Z5Z6Z7Z8Z9Z0Z1Z2Z3Z4Z5Z6Z7Z8Z9Z0ZA==
-----END EC PRIVATE KEY-----`;
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET]");
    });
  });

  describe("Normal text preservation", () => {
    it("should not modify normal text without secrets", () => {
      const redactor = createDefaultRedactor();
      const input = "Hello, this is a normal message with no secrets.";
      const result = redactor.redact(input);
      expect(result).toBe(input);
    });

    it("should not modify code without secrets", () => {
      const redactor = createDefaultRedactor();
      const input = "const x = 42; function hello() { return 'world'; }";
      const result = redactor.redact(input);
      expect(result).toBe(input);
    });

    it("should not modify markdown documentation", () => {
      const redactor = createDefaultRedactor();
      const input = "# Heading\n\nThis is a paragraph with **bold** text.";
      const result = redactor.redact(input);
      expect(result).toBe(input);
    });
  });

  describe("Idempotency", () => {
    it("should be idempotent: redact(redact(text)) === redact(text)", () => {
      const redactor = createDefaultRedactor();
      const input =
        "My key is sk-abc123xyz789foo456bar789baz012 and my token is ghp_xxxxxxxxxxxxxxxxxxxx";
      const once = redactor.redact(input);
      const twice = redactor.redact(once);
      expect(twice).toBe(once);
    });

    it("should be idempotent for private key blocks", () => {
      const redactor = createDefaultRedactor();
      const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MqK8k7f5z3h4j8wQ
ABCD1234
-----END RSA PRIVATE KEY-----`;
      const once = redactor.redact(input);
      const twice = redactor.redact(once);
      expect(twice).toBe(once);
    });

    it("should be idempotent for env variable assignments", () => {
      const redactor = createDefaultRedactor();
      const input = "export OPENAI_API_KEY=sk-test1234567890abcdef";
      const once = redactor.redact(input);
      const twice = redactor.redact(once);
      expect(twice).toBe(once);
    });
  });

  describe("addPattern", () => {
    it("should add a custom pattern that gets applied", () => {
      const redactor = createDefaultRedactor();
      redactor.addPattern("custom_token", /mytoken_[a-z0-9]{8,}/gi);
      const input = "Here is my token: mytoken_abc12345xyz";
      const result = redactor.redact(input);
      expect(result).toBe("Here is my token: [REDACTED_SECRET]");
    });

    it("should support custom replacement string", () => {
      const redactor = createDefaultRedactor();
      redactor.addPattern(
        "custom_secret",
        /SECRET_[A-Z0-9]+/g,
        "[REDACTED_CUSTOM]",
      );
      const input = "The code is SECRET_ABC123";
      const result = redactor.redact(input);
      expect(result).toBe("The code is [REDACTED_CUSTOM]");
    });

    it("should make non-global patterns global automatically", () => {
      const redactor = createDefaultRedactor();
      redactor.addPattern("non_global", /TEST_[0-9]+/);
      const input = "Tokens: TEST_123 and TEST_456";
      const result = redactor.redact(input);
      expect(result).toBe("Tokens: [REDACTED_SECRET] and [REDACTED_SECRET]");
    });

    it("should apply custom patterns alongside defaults", () => {
      const redactor = createDefaultRedactor();
      redactor.addPattern("custom_token", /custom_[a-z]+/gi);
      const input = "sk-abc123xyz789foo456bar789baz012 and custom_secret";
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET] and [REDACTED_SECRET]");
    });
  });

  describe("Tailscale auth key redaction", () => {
    it("should redact tailscale auth keys", () => {
      const redactor = createDefaultRedactor();
      const input = "tskey-auth-kjhgfdsa-mnopqrstu";
      const result = redactor.redact(input);
      expect(result).toBe("[REDACTED_SECRET]");
    });
  });

  describe("Mixed content redaction", () => {
    it("should redact multiple secrets in one text", () => {
      const redactor = createDefaultRedactor();
      const input =
        "API key: sk-abc123xyz789foo456bar789baz012, GitHub: ghp_xxxxxxxxxxxxxxxxxxxx, more text";
      const result = redactor.redact(input);
      expect(result).toBe(
        "API key: [REDACTED_SECRET], GitHub: [REDACTED_SECRET], more text",
      );
    });

    it("should preserve surrounding text when redacting", () => {
      const redactor = createDefaultRedactor();
      const input = "prefix sk-middle1234567890abcdef1234567890 suffix";
      const result = redactor.redact(input);
      expect(result).toBe("prefix [REDACTED_SECRET] suffix");
    });
  });
});
