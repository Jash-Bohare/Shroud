import { describe, expect, it } from "vitest";
import { sanitizeToolOutput } from "../../src/agent/sanitize.js";

describe("Agent Tool Sanitizer", () => {
  it("drops sensitive keys like code, link, address, and txid", () => {
    const raw = {
      product: "Swiggy ₹500",
      code: "SWIGGY-SECRET-PIN-1234",
      redemption_url: "https://example.com/redeem",
      link: "https://example.com/voucher",
      address: "utest1xhnxtzmrum59ygs88ggyuhyv9f40f4qqwhpx6e3gn7n8hddm3m0vatlug2ya2m4rd6wlxj8vvje0tpu0l6wh6dxn96q8lhe6n340mznpx353e8gfnc5l03mj0xg7n0f47kg3sjlphyx6d2xgu9fzcdn209nqcs0q6xmu2s4cv4wkmpn6js0fj882807eya78wwacujhn5l052930dh2",
      txid: "00755b8eec3932954f021907ef8eaf40a50031912dac68644f95240eff5520af",
      attempt_id: "att_12345",
      safeField: "safe value"
    };

    const sanitized = sanitizeToolOutput(raw);
    expect(sanitized.code).toBeUndefined();
    expect(sanitized.redemption_url).toBeUndefined();
    expect(sanitized.link).toBeUndefined();
    expect(sanitized.address).toBeUndefined();
    expect(sanitized.txid).toBeUndefined();
    expect(sanitized.attempt_id).toBeUndefined();
    expect(sanitized.safeField).toBe("safe value");
    expect(sanitized.product).toBe("Swiggy ₹500");
  });

  it("masks Zcash addresses and 64-hex TXIDs embedded in text", () => {
    const raw = {
      message:
        "Sent payment to utest1xhnxtzmrum59ygs88ggyuhyv9f40f4qqwhpx6e3gn7n8hddm3m0vatlug2ya2m4rd6wlxj8vvje0tpu0l6wh6dxn96q8lhe6n340mznpx353e8gfnc5l03mj0xg7n0f47kg3sjlphyx6d2xgu9fzcdn209nqcs0q6xmu2s4cv4wkmpn6js0fj882807eya78wwacujhn5l052930dh2 in tx 00755b8eec3932954f021907ef8eaf40a50031912dac68644f95240eff5520af."
    };

    const sanitized = sanitizeToolOutput(raw);
    expect(sanitized.message).toContain("[ADDRESS_REDACTED]");
    expect(sanitized.message).toContain("[TXID_REDACTED]");
    expect(sanitized.message).not.toContain("utest1");
    expect(sanitized.message).not.toContain("00755b8eec393295");
  });

  it("masks long alphanumeric code patterns in text", () => {
    const raw = {
      note: "Your voucher pin is ABCD-EFGH-IJKL-MNOP."
    };

    const sanitized = sanitizeToolOutput(raw);
    expect(sanitized.note).toContain("[CODE_REDACTED]");
    expect(sanitized.note).not.toContain("ABCD-EFGH");
  });

  it("strips URLs and control characters from text", () => {
    const raw = {
      info: "Visit https://bitrefill.com/redeem for help \x00\x08."
    };

    const sanitized = sanitizeToolOutput(raw);
    expect(sanitized.info).toContain("[URL_REDACTED]");
    expect(sanitized.info).not.toContain("https://");
    expect(sanitized.info).not.toContain("\x00");
  });

  it("truncates names over 80 chars and descriptions over 300 chars", () => {
    const raw = {
      name: "A".repeat(100),
      description: "D".repeat(350)
    };

    const sanitized = sanitizeToolOutput(raw);
    expect(sanitized.name.length).toBe(83); // 80 + "..."
    expect(sanitized.description.length).toBe(303); // 300 + "..."
  });
});

