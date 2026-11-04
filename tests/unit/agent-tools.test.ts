import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, TOOL_SCHEMAS, ToolExecutor } from "../../src/agent/tools.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { VaultService } from "../../src/zcash/vault.js";

function setupTestDb() {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE purchases (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_type TEXT NOT NULL,
      country TEXT,
      package_id TEXT,
      value_num REAL,
      face_value TEXT NOT NULL,
      face_currency TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      price_source TEXT NOT NULL,
      quoted_zats INTEGER NOT NULL,
      pay_zats INTEGER,
      pay_to TEXT,
      pay_to_memo TEXT,
      swap_ref TEXT,
      quote_expires_at TEXT,
      policy_decision TEXT,
      policy_reasons TEXT NOT NULL DEFAULT '[]',
      approval_nonce TEXT,
      approval_expires_at TEXT,
      attempt_id TEXT,
      zec_txid TEXT,
      merchant_invoice_id TEXT,
      merchant_order_id TEXT,
      code_ciphertext TEXT,
      code_hash TEXT,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id TEXT,
      type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      simulated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("Agent Tools & Security Constraints", () => {
  it("enforces that NO tool schema accepts forbidden cryptographic or payment fields", () => {
    const FORBIDDEN_WORDS = [
      "address",
      "zats",
      "zec",
      "memo",
      "file",
      "path",
      "url",
      "cmd",
      "token",
      "key",
      "identity",
      "private"
    ];

    for (const tool of AGENT_TOOLS) {
      const props = (tool.function.parameters as any)?.properties || {};
      const propNames = Object.keys(props);

      for (const name of propNames) {
        for (const forbidden of FORBIDDEN_WORDS) {
          expect(
            name.toLowerCase(),
            `Tool "${tool.function.name}" must not have forbidden parameter "${name}"`
          ).not.toContain(forbidden);
        }
      }
    }
  });

  it("validates get_quote requires exactly one of package_id or value", () => {
    const validPackage = TOOL_SCHEMAS.get_quote.safeParse({
      product_id: "swiggy-in",
      package_id: "swiggy-500"
    });
    expect(validPackage.success).toBe(true);

    const validValue = TOOL_SCHEMAS.get_quote.safeParse({
      product_id: "amazon-in",
      value: 500
    });
    expect(validValue.success).toBe(true);

    // Both provided -> fail
    const both = TOOL_SCHEMAS.get_quote.safeParse({
      product_id: "swiggy-in",
      package_id: "swiggy-500",
      value: 500
    });
    expect(both.success).toBe(false);

    // Neither provided -> fail
    const neither = TOOL_SCHEMAS.get_quote.safeParse({
      product_id: "swiggy-in"
    });
    expect(neither.success).toBe(false);
  });

  it("enforces per-message rate limit of maximum 2 purchase requests", async () => {
    const db = setupTestDb();
    const policyStore = new PolicyStore(db);
    const merchant = new MockMerchantAdapter();
    const pricing = new FixedPriceSource(35);
    const fakeVault = {
      getDeskAddress: async () => "utest1deskaddresstest",
      getBalance: async () => ({
        totalZats: 100_000_000n,
        spendableZats: 100_000_000n,
        pendingZats: 0n,
        transparentZats: 0n,
        ironwoodSpendable: 100_000_000n,
        orchardSpendable: 0n,
        saplingSpendable: 0n,
        chainTipHeight: 4500000
      })
    } as unknown as VaultService;

    const executor = new DemoSwapExecutor({
      vault: fakeVault,
      merchant,
      amountScale: 0.01,
      minDemoZats: 10_000n
    });

    const purchaseService = new PurchaseService({
      db,
      merchant,
      pricing,
      executor,
      vault: fakeVault,
      policyStore,
      mode: "demo"
    });

    const createdPurchaseIds: string[] = [];
    const toolExec = new ToolExecutor({
      merchant,
      purchaseService,
      createdPurchaseIds
    });

    // Call 1 -> Success
    const res1: any = await toolExec.execute(
      "request_purchase",
      JSON.stringify({
        product_id: "swiggy-in",
        package_id: "swiggy-500",
        reason: "Lunch"
      })
    );
    expect(res1.purchase_id).toBeDefined();

    // Call 2 -> Success
    const res2: any = await toolExec.execute(
      "request_purchase",
      JSON.stringify({
        product_id: "swiggy-in",
        package_id: "swiggy-500",
        reason: "Dinner"
      })
    );
    expect(res2.purchase_id).toBeDefined();

    // Call 3 -> Rate limit exceeded
    const res3: any = await toolExec.execute(
      "request_purchase",
      JSON.stringify({
        product_id: "swiggy-in",
        package_id: "swiggy-500",
        reason: "Midnight snack"
      })
    );
    expect(res3.error).toContain("Purchase limit reached");
    expect(createdPurchaseIds).toHaveLength(2);
  });
});

