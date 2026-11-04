import { Receipt, Mode } from "../shared/types.js";
import { ShroudError } from "../shared/errors.js";

export const RECEIPT_PREFIX = "SHRD1";
export const MAX_MEMO_BYTES = 512;

export interface EncodeReceiptInput {
  id: string;
  attemptId: string;
  timestamp?: number;
  mode: Mode;
  productId: string;
  productName: string;
  faceValue: string;
  faceCurrency: string;
  priceCents: number;
  zatsPaid: bigint | string;
  invoiceId?: string;
  orderId?: string;
  swapRef: string;
}

/**
 * Encodes a purchase receipt into a compact SHRD1 memo string (<= 512 bytes).
 * Progressively truncates product name and drops invoice/order IDs if needed to fit.
 */
export function encodeReceipt(input: EncodeReceiptInput): string {
  const t = Number(input.timestamp ?? Math.floor(Date.now() / 1000));
  const z = typeof input.zatsPaid === "bigint" ? input.zatsPaid.toString() : String(input.zatsPaid);

  const receipt: Receipt = {
    v: 1,
    id: input.id,
    a: input.attemptId,
    t,
    m: input.mode,
    p: input.productId,
    n: input.productName,
    fv: input.faceValue,
    fc: input.faceCurrency,
    u: Number(input.priceCents),
    z,
    x: input.swapRef
  };

  if (input.invoiceId) receipt.i = input.invoiceId;
  if (input.orderId) receipt.o = input.orderId;

  const replacer = (_: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
  let serialized = `${RECEIPT_PREFIX}${JSON.stringify(receipt, replacer)}`;
  let bytes = Buffer.byteLength(serialized, "utf-8");

  if (bytes <= MAX_MEMO_BYTES) {
    return serialized;
  }

  // Strategy 1: Truncate product name
  let name = input.productName;
  while (bytes > MAX_MEMO_BYTES && name.length > 5) {
    name = name.slice(0, -5);
    receipt.n = name;
    serialized = `${RECEIPT_PREFIX}${JSON.stringify(receipt, replacer)}`;
    bytes = Buffer.byteLength(serialized, "utf-8");
  }

  // Strategy 2: Drop optional invoice and order ids if still too long
  if (bytes > MAX_MEMO_BYTES) {
    delete receipt.i;
    delete receipt.o;
    serialized = `${RECEIPT_PREFIX}${JSON.stringify(receipt, replacer)}`;
    bytes = Buffer.byteLength(serialized, "utf-8");
  }

  // Strategy 3: Hard truncate name further if still needed
  while (bytes > MAX_MEMO_BYTES && receipt.n.length > 0) {
    receipt.n = receipt.n.slice(0, -1);
    serialized = `${RECEIPT_PREFIX}${JSON.stringify(receipt, replacer)}`;
    bytes = Buffer.byteLength(serialized, "utf-8");
  }

  if (bytes > MAX_MEMO_BYTES) {
    throw new ShroudError("INVALID_MEMO", `Unable to compress receipt memo below 512 bytes (got ${bytes} bytes)`);
  }

  return serialized;
}

/**
 * Decodes a SHRD1 receipt from a raw memo string.
 * Returns null if not a SHRD1 receipt or corrupted. Never throws.
 */
export function decodeReceipt(text: string): Receipt | null {
  if (!text || typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith(RECEIPT_PREFIX)) {
    return null;
  }

  const jsonStr = trimmed.slice(RECEIPT_PREFIX.length);
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.v === 1 && typeof parsed.id === "string" && typeof parsed.a === "string") {
      return parsed as Receipt;
    }
    return null;
  } catch {
    return null;
  }
}

