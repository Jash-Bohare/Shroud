import { describe, it, expect } from "vitest";
import pino from "pino";
import { REDACTED_PATHS } from "../../src/shared/logger.js";

describe("logger redaction", () => {
  it("redacts sensitive fields in logged objects", () => {
    let output = "";
    const testStream = {
      write: (msg: string) => {
        output += msg;
      }
    };

    const testLogger = pino(
      {
        redact: {
          paths: REDACTED_PATHS,
          censor: "[REDACTED]"
        }
      },
      testStream
    );

    testLogger.info({
      apiKey: "secret-key-12345",
      token: "secret-token",
      nested: {
        code: "GIFT-999-SECRET",
        mnemonic: "twelve secret words that should never leak",
        identityPath: "/safe/path.txt"
      },
      publicInfo: "safe-product-name"
    });

    const parsed = JSON.parse(output);
    expect(parsed.apiKey).toBe("[REDACTED]");
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.nested.code).toBe("[REDACTED]");
    expect(parsed.nested.mnemonic).toBe("[REDACTED]");
    expect(parsed.publicInfo).toBe("safe-product-name");
  });
});

