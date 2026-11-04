import { describe, it, expect } from "vitest";
import {
  parseBalanceJson,
  parseAccounts,
  parseUnifiedAddress,
  parseTxid,
  parseListTxJson,
  redactCliArgs
} from "../../src/zcash/devtool.js";

describe("devtool output parsers", () => {
  it("parses balance JSON correctly", () => {
    const fixture = JSON.stringify({
      total: 250000000,
      sapling_spendable: 0,
      orchard_spendable: 0,
      ironwood_spendable: 200000000,
      transparent_spendable: 10000000,
      chain_tip_height: 3154200
    });

    const parsed = parseBalanceJson(fixture);
    expect(parsed.totalZats).toBe(250000000n);
    expect(parsed.spendableZats).toBe(200000000n); // ironwood + orchard + sapling
    expect(parsed.ironwoodSpendable).toBe(200000000n);
    expect(parsed.transparentZats).toBe(10000000n);
    expect(parsed.pendingZats).toBe(40000000n); // total - spendable - transparent
    expect(parsed.chainTipHeight).toBe(3154200);
  });

  it("parses list-accounts output", () => {
    const fixture = `
Account 0192e2fb-3d9a-71b8-80f4-500b12345678 (birthday height 3100000)
     Name: vault
     UIVK: uivk1test...
     UFVK: ufvk1testfullviewingkey...
Account 0192e2fc-9988-7766-5544-112233445566 (birthday height 3100050)
     Name: receipts
     UIVK: uivk1receipts...
     UFVK: ufvk1receiptsviewingkey...
`;
    const accounts = parseAccounts(fixture);
    expect(accounts.length).toBe(2);
    expect(accounts[0].name).toBe("vault");
    expect(accounts[0].uuid).toBe("0192e2fb-3d9a-71b8-80f4-500b12345678");
    expect(accounts[0].birthdayHeight).toBe(3100000);
    expect(accounts[0].ufvk).toBe("ufvk1testfullviewingkey...");

    expect(accounts[1].name).toBe("receipts");
    expect(accounts[1].uuid).toBe("0192e2fc-9988-7766-5544-112233445566");
  });

  it("parses unified address", () => {
    const stdout = "Generated unified address: utest1z8x5c8e7w9q4p2m3k5n7j9h2g4f6d8s0a1b2c3d4e5f6g7h8j9k0l1m2n3";
    expect(parseUnifiedAddress(stdout)).toBe("utest1z8x5c8e7w9q4p2m3k5n7j9h2g4f6d8s0a1b2c3d4e5f6g7h8j9k0l1m2n3");
  });

  it("parses txid from last line of pay command output", () => {
    const stdout = `
Building transaction...
Proving transaction with Ironwood circuit...
Broadcasting transaction...
3f9a7b5c1d8e2f4a6b0c9e7d5a3f1b8c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f12
`;
    expect(parseTxid(stdout)).toBe("3f9a7b5c1d8e2f4a6b0c9e7d5a3f1b8c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f12");
  });

  it("parses list-tx json output", () => {
    const stdout = JSON.stringify([
      { txid: "3f9a7b5c1d8e2f4a6b0c9e7d5a3f1b8c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f12", mined_height: 3150000 },
      { txid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", mined_height: null }
    ]);
    const list = parseListTxJson(stdout);
    expect(list.length).toBe(2);
    expect(list[0].minedHeight).toBe(3150000);
    expect(list[1].minedHeight).toBeNull();
  });

  it("redacts sensitive arguments in CLI logging", () => {
    const args = [
      "pay",
      "uuid-123",
      "-i",
      "/secret/path/to/identity.txt",
      "--payment-uri",
      "zcash:?address=u1...&memo=c2VjcmV0"
    ];
    const redacted = redactCliArgs(args);
    expect(redacted[3]).toBe("[REDACTED_IDENTITY_FILE]");
    expect(redacted[5]).toBe("[REDACTED_PAYMENT_URI]");
  });
});

