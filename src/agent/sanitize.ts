/**
 * Sanitizes tool results before they are passed back into the LLM context.
 * Strips sensitive fields, masks addresses/txids/codes, and cleans merchant descriptions.
 */

const DROP_KEY_PATTERNS = [
  /^code$/i,
  /^redemption/i,
  /^link$/i,
  /^address$/i,
  /^pay_to$/i,
  /^pay_address$/i,
  /^txid$/i,
  /^zec_txid$/i,
  /^deposit/i,
  /^attempt/i,
  /^invoice_url$/i,
  /^code_ciphertext$/i,
  /^code_hash$/i
];

const ZCASH_ADDR_REGEX = /\b(utest1[a-z0-9]{30,}|u1[a-z0-9]{30,}|zs1[a-z0-9]{30,}|t1[a-zA-Z0-9]{30,})\b/gi;
const TXID_HEX_REGEX = /\b[0-9a-fA-F]{64}\b/g;
const CODE_PATTERN_REGEX = /\b[A-Z0-9]{4,}(-[A-Z0-9]{4,}){2,}\b/g;
const URL_REGEX = /https?:\/\/[^\s]+/gi;
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeString(str: string, fieldName?: string): string {
  // Strip control characters
  let clean = str.replace(CONTROL_CHARS_REGEX, "");

  // Strip URLs from text
  clean = clean.replace(URL_REGEX, "[URL_REDACTED]");

  // Mask Zcash addresses
  clean = clean.replace(ZCASH_ADDR_REGEX, "[ADDRESS_REDACTED]");

  // Mask 64-hex TXIDs
  clean = clean.replace(TXID_HEX_REGEX, "[TXID_REDACTED]");

  // Mask gift code patterns
  clean = clean.replace(CODE_PATTERN_REGEX, "[CODE_REDACTED]");

  // Length caps
  if (fieldName === "name" && clean.length > 80) {
    clean = clean.slice(0, 80) + "...";
  } else if (fieldName === "description" && clean.length > 300) {
    clean = clean.slice(0, 300) + "...";
  }

  return clean;
}

export function sanitizeToolOutput(obj: unknown, keyName?: string): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return sanitizeString(obj, keyName);
  }

  if (typeof obj === "number" || typeof obj === "boolean" || typeof obj === "bigint") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeToolOutput(item, keyName));
  }

  if (typeof obj === "object") {
    const sanitizedObj: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Check if key should be dropped
      const shouldDrop = DROP_KEY_PATTERNS.some((pattern) => pattern.test(k));
      if (shouldDrop) {
        continue;
      }

      sanitizedObj[k] = sanitizeToolOutput(v, k);
    }

    return sanitizedObj;
  }

  return obj;
}

