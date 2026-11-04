import { ShroudError } from "../shared/errors.js";
import { zatsToZecExact } from "../shared/money.js";

export interface Zip321Payment {
  address: string;
  zats: bigint;
  memo?: Uint8Array | string; // <= 512 bytes
  label?: string;
}

/**
 * Converts a Uint8Array or string to URL-safe base64 without padding (RFC 4648 §5).
 */
export function toBase64Url(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decodes a URL-safe base64 string without padding.
 */
export function fromBase64Url(b64url: string): Buffer {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  return Buffer.from(b64, "base64");
}

/**
 * Checks if an address is transparent (t1 on mainnet, tm on testnet).
 */
export function isTransparentAddress(address: string): boolean {
  return address.startsWith("t1") || address.startsWith("tm");
}

/**
 * Builds a ZIP-321 payment URI for one or more payment outputs.
 * Standard format:
 * zcash:?address=<a0>&amount=<z0>[&memo=<m0>]&address.1=<a1>&amount.1=<z1>&memo.1=<m1>...
 */
export function buildPaymentUri(payments: Zip321Payment[]): string {
  if (payments.length === 0) {
    throw new ShroudError("INVALID_SELECTION", "At least one payment output is required for ZIP-321 URI");
  }

  const queryParts: string[] = [];

  for (let i = 0; i < payments.length; i++) {
    const p = payments[i];
    const indexSuffix = i === 0 ? "" : `.${i}`;

    if (!p.address) {
      throw new ShroudError("INVALID_ADDRESS", `Missing recipient address for output ${i}`);
    }

    // Address
    queryParts.push(`address${indexSuffix}=${encodeURIComponent(p.address)}`);

    // Amount (in decimal ZEC, up to 8 decimals without trailing zeros)
    const amountStr = zatsToZecExact(p.zats);
    queryParts.push(`amount${indexSuffix}=${encodeURIComponent(amountStr)}`);

    // Memo (if present)
    if (p.memo) {
      if (isTransparentAddress(p.address)) {
        throw new ShroudError(
          "INVALID_MEMO",
          `Cannot attach a memo to transparent recipient address ${p.address} at output ${i}`
        );
      }

      const memoBytes = typeof p.memo === "string" ? Buffer.from(p.memo, "utf-8") : Buffer.from(p.memo);
      if (memoBytes.length > 512) {
        throw new ShroudError(
          "INVALID_MEMO",
          `Memo exceeds 512-byte limit (${memoBytes.length} bytes) at output ${i}`
        );
      }

      const b64urlMemo = toBase64Url(memoBytes);
      queryParts.push(`memo${indexSuffix}=${b64urlMemo}`);
    }

    if (p.label) {
      queryParts.push(`label${indexSuffix}=${encodeURIComponent(p.label)}`);
    }
  }

  return `zcash:?${queryParts.join("&")}`;
}

