import { describe, expect, it } from "vitest";
import { decryptCode, encryptCode } from "../../src/shared/crypto.js";
import { ShroudError } from "../../src/shared/errors.js";

describe("Crypto Module (AES-256-GCM)", () => {
  const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("encrypts and decrypts cleartext codes accurately", () => {
    const original = "AMZN-SECRET-9874-ABCD";
    const { ciphertext, codeHash } = encryptCode(original, testKey);

    expect(ciphertext).toBeDefined();
    expect(codeHash).toHaveLength(16);

    const decrypted = decryptCode(ciphertext, testKey);
    expect(decrypted).toBe(original);
  });

  it("generates different ciphertexts for the same plaintext due to random IV", () => {
    const original = "SWIGGY-100-PIN";
    const enc1 = encryptCode(original, testKey);
    const enc2 = encryptCode(original, testKey);

    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    // But both have the exact same hash
    expect(enc1.codeHash).toBe(enc2.codeHash);

    // And both decrypt to original
    expect(decryptCode(enc1.ciphertext, testKey)).toBe(original);
    expect(decryptCode(enc2.ciphertext, testKey)).toBe(original);
  });

  it("fails decryption if corrupted or wrong key", () => {
    const original = "TEST-CODE-123";
    const { ciphertext } = encryptCode(original, testKey);

    const wrongKey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    try {
      decryptCode(ciphertext, wrongKey);
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(ShroudError);
      expect(err.code).toBe("DECRYPTION_FAILED");
    }
  });
});
