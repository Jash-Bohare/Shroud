import { describe, expect, it } from "vitest";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseRow } from "../../src/router/types.js";
import { VaultService } from "../../src/zcash/vault.js";

describe("Swap Executors", () => {
  const merchant = new MockMerchantAdapter();

  // Create a mock VaultService
  const fakeVault = {
    getDeskAddress: async () => "utest1deskfakeaddress12345",
    findDeskPayment: async (memo: string) =>
      memo === "SHROUD-DESK p_test_demo_2" ? { txid: "0123456789abcdef", valueZats: 17142n, confirmations: 1 } : null
  } as unknown as VaultService;

  it("DemoSwapExecutor prepares scaled payment to desk address", async () => {
    const executor = new DemoSwapExecutor({
      vault: fakeVault,
      merchant,
      amountScale: 0.01,
      minDemoZats: 10_000n
    });

    const purchase: PurchaseRow = {
      id: "p_test_demo_1",
      status: "CREATED",
      mode: "demo",
      source: "telegram",
      reason: "Test purchase",
      product_id: "swiggy-in",
      product_name: "Swiggy",
      product_type: "giftcard",
      country: "IN",
      package_id: "swiggy-500",
      value_num: 500,
      face_value: "500",
      face_currency: "INR",
      price_cents: 600,
      price_source: "fixed",
      quoted_zats: 1_714_285n, // ~0.017 ZEC
      pay_zats: null,
      pay_to: null,
      pay_to_memo: null,
      swap_ref: null,
      quote_expires_at: null,
      policy_decision: null,
      policy_reasons: "[]",
      approval_nonce: null,
      approval_expires_at: null,
      attempt_id: null,
      zec_txid: null,
      merchant_invoice_id: null,
      merchant_order_id: null,
      code_ciphertext: null,
      code_hash: null,
      error_code: null,
      error_message: null,
      retry_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const prep = await executor.prepare(purchase);
    expect(prep.payTo).toBe("utest1deskfakeaddress12345");
    // 1,714,285 * 0.01 = 17,142 zats (integer division)
    expect(prep.payZats).toBe(17142n);
    expect(prep.payToMemo).toBe("SHROUD-DESK p_test_demo_1");
    expect(prep.swapRef).toBe("desk");
  });

  it("DemoSwapExecutor polls confirmations and resolves SETTLED", async () => {
    const executor = new DemoSwapExecutor({
      vault: fakeVault,
      merchant,
      minConf: 1
    });

    const purchase = {
      id: "p_test_demo_2",
      zec_txid: "0123456789abcdef",
      pay_zats: 17142n,
      quoted_zats: 1_714_285n,
      pay_to_memo: "SHROUD-DESK p_test_demo_2",
      created_at: new Date().toISOString()
    } as PurchaseRow;

    const res = await executor.poll(purchase);
    expect(res).toBe("SETTLED");
  });
});
