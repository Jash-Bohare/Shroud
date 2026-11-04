import { describe, it, expect } from "vitest";
import { buildPaymentUri, toBase64Url, fromBase64Url } from "../../src/zcash/zip321.js";

describe("ZIP-321 Payment URI Builder", () => {
  it("encodes base64url correctly without padding", () => {
    const text = "hello world";
    const encoded = toBase64Url(text);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");

    const decoded = fromBase64Url(encoded).toString("utf-8");
    expect(decoded).toBe(text);
  });

  it("builds a single payment URI", () => {
    const uri = buildPaymentUri([
      {
        address: "utest1exampleaddress",
        zats: 100_000_000n // 1 ZEC
      }
    ]);
    expect(uri).toBe("zcash:?address=utest1exampleaddress&amount=1");
  });

  it("builds a multi-output payment URI with a memo", () => {
    const uri = buildPaymentUri([
      {
        address: "utest1deskaccount",
        zats: 10_000n
      },
      {
        address: "utest1receiptsaccount",
        zats: 0n,
        memo: "SHRD1-test-receipt"
      }
    ]);

    expect(uri).toContain("address=utest1deskaccount");
    expect(uri).toContain("amount=0.0001");
    expect(uri).toContain("address.1=utest1receiptsaccount");
    expect(uri).toContain("amount.1=0");
    expect(uri).toContain("memo.1=");
  });

  it("rejects memos attached to transparent addresses", () => {
    expect(() =>
      buildPaymentUri([
        {
          address: "t1VpMigELggipcEZx4WnhBGngR7UXMmBpBz",
          zats: 50_000n,
          memo: "invalid-memo"
        }
      ])
    ).toThrow(/transparent/i);
  });

  it("rejects memos exceeding 512 bytes", () => {
    const hugeMemo = "A".repeat(513);
    expect(() =>
      buildPaymentUri([
        {
          address: "utest1shielded",
          zats: 10_000n,
          memo: hugeMemo
        }
      ])
    ).toThrow(/512-byte limit/i);
  });
});

