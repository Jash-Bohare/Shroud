import { randomBytes } from "node:crypto";

/**
 * Generates a collision-resistant, sortable ID using timestamp prefix + random hex.
 * e.g. "p_01J..." or "att_01J..."
 */
function generatePrefixedId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const randomPart = randomBytes(8).toString("hex");
  return `${prefix}${timestamp}_${randomPart}`;
}

export function generatePurchaseId(): string {
  return generatePrefixedId("p_");
}

export function generateAttemptId(): string {
  return generatePrefixedId("att_");
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

