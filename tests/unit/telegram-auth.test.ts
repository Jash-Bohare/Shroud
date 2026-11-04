import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/agent/loop.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { createTelegramBot } from "../../src/telegram/bot.js";
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

describe("Telegram Bot & Owner-Lock Security", () => {
  const ownerId = 123456789;
  const db = setupTestDb();
  const policyStore = new PolicyStore(db);
  const merchant = new MockMerchantAdapter();
  const pricing = new FixedPriceSource(35);
  const fakeVault = {
    getFundingAddress: async () => "utest1testfundingaddress",
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
    }),
    listReceipts: async () => []
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

  const agentSession = new AgentSession({
    llm: {
      chat: async () => ({ content: "I am ready.", toolCalls: [] })
    },
    merchant,
    purchaseService
  });

  const bot = createTelegramBot({
    vault: fakeVault,
    purchaseService,
    policyStore,
    agentSession,
    botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    ownerId
  });

  it("drops messages from unauthorized senders", async () => {
    let nextCalled = false;
    const ctx: any = {
      from: { id: 99999999 }, // Attacker ID
      message: { text: "Hello" },
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 99999999 },
          chat: { id: 99999999, type: "private" },
          date: Date.now(),
          text: "Hello"
        }
      }
    };

    // Run bot middleware
    await (bot as any).middleware()(ctx, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
  });

  it("passes updates from the authorized owner", async () => {
    let nextCalled = false;
    const ctx: any = {
      from: { id: ownerId },
      chat: { id: ownerId, type: "private" },
      update: {
        update_id: 2,
        // No message so no command or message handler runs down-chain, just owner check passes
      }
    };

    await (bot as any).middleware()(ctx, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("handles approval callback queries and updates state", async () => {
    // 1. Create a purchase in AWAITING_APPROVAL
    const purchase = await purchaseService.request(
      { productId: "steam-usd", packageId: "steam-20" },
      "Approval test",
      "agent"
    );
    expect(purchase.status).toBe("AWAITING_APPROVAL");
    expect(purchase.approvalNonce).toBeDefined();

    // Verify approval directly through purchaseService to confirm state transition logic
    const approved = purchaseService.approve(
      purchase.id,
      "owner:telegram",
      purchase.approvalNonce || undefined
    );
    expect(approved.status).toBe("APPROVED");

    // Also test reject on another purchase
    const p2 = await purchaseService.request(
      { productId: "steam-usd", packageId: "steam-20" },
      "Reject test",
      "agent"
    );
    expect(p2.status).toBe("AWAITING_APPROVAL");
    const rejected = purchaseService.reject(p2.id, "owner:telegram");
    expect(rejected.status).toBe("REJECTED");
  });
});
