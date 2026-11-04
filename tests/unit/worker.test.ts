import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { PurchaseWorker } from "../../src/router/worker.js";
import { decryptCode } from "../../src/shared/crypto.js";
import { VaultService } from "../../src/zcash/vault.js";

function setupTestDb() {
  const db = new Database(":memory:");
  db.exec(`
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
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("PurchaseWorker Lifecycle & Crash Recovery", () => {
  it("advances an APPROVED purchase all the way to DELIVERED", async () => {
    const db = setupTestDb();
    const merchant = new MockMerchantAdapter();

    let payCallCount = 0;
    const fakeVault = {
      payWithReceipt: async () => {
        payCallCount++;
        return { txid: "tx_mock_12345" };
      },
      findReceiptByAttempt: async () => null,
      sync: async () => {}
    } as unknown as VaultService;

    const fakeExecutor = {
      mode: "demo" as const,
      prepare: async () => ({
        payTo: "utest1desk",
        payZats: 10_000n,
        swapRef: "desk"
      }),
      afterPaid: async () => {},
      poll: async () => "SETTLED" as const,
      order: async () => ({ invoiceId: "inv_1", orderId: "ord_1" })
    };

    const worker = new PurchaseWorker({
      db,
      vault: fakeVault,
      merchant,
      executor: fakeExecutor
    });

    const purchaseId = "p_flow_1";
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO purchases (
        id, status, mode, source, product_id, product_name, product_type,
        face_value, face_currency, price_cents, price_source, quoted_zats,
        pay_zats, pay_to, swap_ref, created_at, updated_at
      ) VALUES (
        ?, 'APPROVED', 'demo', 'telegram', 'swiggy-in', 'Swiggy', 'giftcard',
        '500', 'INR', 600, 'fixed', 17000000,
        10000, 'utest1desk', 'desk', ?, ?
      )
    `).run(purchaseId, now, now);

    // 1. Tick 1: APPROVED -> enters PAYING -> broadcasts tx -> PAID
    await worker.tick();
    let p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as any;
    expect(p.status).toBe("PAID");
    expect(p.zec_txid).toBe("tx_mock_12345");
    expect(payCallCount).toBe(1);

    // 2. Tick 2: PAID -> SWAPPING
    await worker.tick();
    p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as any;
    expect(p.status).toBe("SWAPPING");

    // 3. Tick 3: SWAPPING -> SWAPPED (poll returns SETTLED)
    await worker.tick();
    p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as any;
    expect(p.status).toBe("SWAPPED");

    // 4. Tick 4: SWAPPED -> ORDERING
    await worker.tick();
    p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as any;
    expect(p.status).toBe("ORDERING");
    expect(p.merchant_order_id).toBe("ord_1");

    // 5. Tick 5: ORDERING -> DELIVERED (code encrypted)
    await worker.tick();
    p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as any;
    expect(p.status).toBe("DELIVERED");
    expect(p.code_ciphertext).toBeDefined();

    const clearCode = decryptCode(p.code_ciphertext);
    expect(clearCode).toMatch(/^MOCK-/);
  });

  it("halts payment execution when policy is paused (kill switch)", async () => {
    const db = setupTestDb();
    const policyStore = new PolicyStore(db);
    policyStore.setPaused(true, "owner:telegram");

    const purchaseId = "p_paused_1";
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO purchases (
        id, status, mode, source, product_id, product_name, product_type,
        face_value, face_currency, price_cents, price_source, quoted_zats,
        pay_zats, pay_to, created_at, updated_at
      ) VALUES (
        ?, 'APPROVED', 'demo', 'agent', 'test-card-1', 'Test', 'giftcard',
        '10', 'USD', 1000, 'fixed', 10000,
        10000, 'utest1desk', ?, ?
      )
    `).run(purchaseId, now, now);

    let payCalled = false;
    const fakeVault = {
      payWithReceipt: async () => {
        payCalled = true;
        return { txid: "should_not_happen" };
      }
    } as unknown as VaultService;

    const fakeExecutor = {
      mode: "demo" as const,
      prepare: async () => ({ payTo: "utest1desk", payZats: 10000n }),
      afterPaid: async () => {},
      poll: async () => "PENDING" as const,
      order: async () => ({ invoiceId: "inv", orderId: "ord" })
    };

    const worker = new PurchaseWorker({
      db,
      vault: fakeVault,
      merchant: new MockMerchantAdapter(),
      executor: fakeExecutor,
      policyStore
    });

    await worker.tick();

    const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as any;
    expect(p.status).toBe("APPROVED"); // Still in APPROVED, did NOT broadcast
    expect(payCalled).toBe(false);
  });

  it("recovers from crash in PAYING state using on-chain receipt without double-paying", async () => {
    const db = setupTestDb();
    const merchant = new MockMerchantAdapter();

    let payCallCount = 0;
    const fakeVault = {
      payWithReceipt: async () => {
        payCallCount++;
        return { txid: "new_tx" };
      },
      // Simulate on-chain receipt discovered from previous attempt
      findReceiptByAttempt: async (attemptId: string) => {
        if (attemptId === "att_crashed_1") {
          return {
            txid: "recovered_txid_6789",
            minedHeight: 4500100,
            receipt: {} as any
          };
        }
        return null;
      },
      sync: async () => {}
    } as unknown as VaultService;

    const fakeExecutor = {
      mode: "demo" as const,
      prepare: async () => ({ payTo: "utest1desk", payZats: 10_000n, swapRef: "desk" }),
      afterPaid: async () => {},
      poll: async () => "PENDING" as const,
      order: async () => ({ invoiceId: "inv_1", orderId: "ord_1" })
    };

    const worker = new PurchaseWorker({
      db,
      vault: fakeVault,
      merchant,
      executor: fakeExecutor
    });

    const purchaseId = "p_crashed_1";
    const now = new Date().toISOString();

    // Insert purchase in PAYING state with attempt_id but NO zec_txid (simulates crash right after pay broadcast)
    db.prepare(`
      INSERT INTO purchases (
        id, status, mode, source, product_id, product_name, product_type,
        face_value, face_currency, price_cents, price_source, quoted_zats,
        pay_zats, pay_to, swap_ref, attempt_id, created_at, updated_at
      ) VALUES (
        ?, 'PAYING', 'demo', 'agent', 'swiggy-in', 'Swiggy', 'giftcard',
        '500', 'INR', 600, 'fixed', 17000000,
        10000, 'utest1desk', 'desk', 'att_crashed_1', ?, ?
      )
    `).run(purchaseId, now, now);

    // Tick worker: should find on-chain receipt and recover to PAID
    await worker.tick();

    const p = db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as any;
    expect(p.status).toBe("PAID");
    expect(p.zec_txid).toBe("recovered_txid_6789");
    // Ensure pay was NEVER called again! Zero double-spending!
    expect(payCallCount).toBe(0);
  });
});
