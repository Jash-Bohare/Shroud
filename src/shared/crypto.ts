import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getEnv } from "../config/env.js";
import { ShroudError } from "./errors.js";

/**
 * Derives a strict 32-byte key buffer from the environment or provided key string.
 */
function getKeyBuffer(keyHexOrString?: string): Buffer {
  const raw = keyHexOrString || getEnv().CODE_ENCRYPTION_KEY;
  if (!raw) {
    throw new ShroudError("CONFIG_ERROR", "CODE_ENCRYPTION_KEY is not configured");
  }

  // If 64 hex characters, parse as hex
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  // Otherwise SHA-256 hash to guarantee exactly 32 bytes
  return createHash("sha256").update(raw).digest();
}

/**
 * Encrypts a sensitive code/pin with AES-256-GCM.
 * Output format: Base64 string of Buffer.concat([12-byte IV, 16-byte AuthTag, Ciphertext]).
 */
export function encryptCode(
  plaintextCode: string,
  keyHexOrString?: string
): { ciphertext: string; codeHash: string } {
  if (!plaintextCode) {
    throw new ShroudError("INVALID_SELECTION", "Cannot encrypt empty code");
  }

  const key = getKeyBuffer(keyHexOrString);
  const iv = randomBytes(12); // Standard 96-bit GCM IV
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintextCode, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // Format: [iv(12) | tag(16) | encrypted]
  const combined = Buffer.concat([iv, tag, encrypted]).toString("base64");
  const codeHash = createHash("sha256").update(plaintextCode).digest("hex").slice(0, 16);

  return {
    ciphertext: combined,
    codeHash
  };
}

/**
 * Decrypts a sensitive code/pin using AES-256-GCM.
 */
export function decryptCode(ciphertextBase64: string, keyHexOrString?: string): string {
  if (!ciphertextBase64) {
    throw new ShroudError("INVALID_SELECTION", "Cannot decrypt empty ciphertext");
  }

  const key = getKeyBuffer(keyHexOrString);
  const combined = Buffer.from(ciphertextBase64, "base64");

  if (combined.length < 28) {
    // 12 bytes IV + 16 bytes Tag = 28 bytes minimum
    throw new ShroudError("DECRYPTION_FAILED", "Invalid ciphertext payload length");
  }

  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(12, 28);
  const encrypted = combined.subarray(28);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err: any) {
    throw new ShroudError("DECRYPTION_FAILED", `Code decryption failed: ${err.message}`);
  }
}

