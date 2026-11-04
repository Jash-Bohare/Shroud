import { describe, it, expect } from "vitest";
import { encodeReceipt, decodeReceipt, RECEIPT_PREFIX, MAX_MEMO_BYTES } from "../../src/zcash/memo.js";

describe("SHRD1 receipt memo encoding and decoding", () => {
  it("encodes and decodes a receipt correctly", () => {
    const input = {
      id: "p_01JABCDEF123456",
      attemptId: "att_01JXYZ987654",
      timestamp: 1762243200,
      mode: "demo" as const,
      productId: "swiggy-india",
      productName: "Swiggy ₹500 Gift Card",
      faceValue: "500",
      faceCurrency: "INR",
      priceCents: 600,
      zatsPaid: 12000000n,
      invoiceId: "inv_123",
      orderId: "ord_456",
      swapRef: "desk"
    };

    const memoText = encodeReceipt(input);
    expect(memoText.startsWith(RECEIPT_PREFIX)).toBe(true);
    expect(Buffer.byteLength(memoText, "utf-8")).toBeLessThanOrEqual(MAX_MEMO_BYTES);

    const decoded = decodeReceipt(memoText);
    expect(decoded).not.toBeNull();
    expect(decoded?.v).toBe(1);
    expect(decoded?.id).toBe(input.id);
    expect(decoded?.a).toBe(input.attemptId);
    expect(decoded?.m).toBe("demo");
    expect(decoded?.p).toBe("swiggy-india");
    expect(decoded?.u).toBe(600);
    expect(decoded?.z).toBe("12000000");
  });

  it("progressively truncates huge product names to fit in 512 bytes", () => {
    const hugeInput = {
      id: "p_01JABCDEF123456",
      attemptId: "att_01JXYZ987654",
      timestamp: 1762243200,
      mode: "demo" as const,
      productId: "very-long-product-id-with-extra-text",
      productName: "A".repeat(800), // Huge product name
      faceValue: "1000",
      faceCurrency: "USD",
      priceCents: 100000,
      zatsPaid: 5000000000n,
      swapRef: "desk"
    };

    const memoText = encodeReceipt(hugeInput);
    expect(Buffer.byteLength(memoText, "utf-8")).toBeLessThanOrEqual(MAX_MEMO_BYTES);

    const decoded = decodeReceipt(memoText);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(hugeInput.id);
  });

  it("returns null for non-SHRD1 memos", () => {
    expect(decodeReceipt("Hello random memo")).toBeNull();
    expect(decodeReceipt("SHRD2{}")).toBeNull();
    expect(decodeReceipt("")).toBeNull();
    expect(decodeReceipt("SHRD1{corrupted-json")).toBeNull();
  });
});

