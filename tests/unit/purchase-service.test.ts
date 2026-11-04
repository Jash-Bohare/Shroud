import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { encryptCode } from "../../src/shared/crypto.js";
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

describe("PurchaseService with Policy Engine", () => {
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

  const service = new PurchaseService({
    db,
    merchant,
    pricing,
    executor,
    vault: fakeVault,
    policyStore,
    mode: "demo"
  });

  it("quotes a selection and includes live policy preview without database mutation", async () => {
    const q = await service.quote({
      productId: "swiggy-in",
      packageId: "swiggy-500"
    });
    expect(q.productName).toBe("Swiggy Food & Instamart Voucher");
    expect(q.priceCents).toBe(600);
    expect(q.priceUsd).toBe("$6.00");
    expect(q.quotedZats).toBe("17142858");
    expect(q.policy?.decision).toBe("ALLOW");

    const rowCount = db.prepare("SELECT COUNT(*) as cnt FROM purchases").get() as any;
    expect(Number(rowCount.cnt)).toBe(0);
  });

  it("auto-approves purchase when price is <= auto-approve threshold ($10)", async () => {
    // swiggy-500 is $6.00 <= $10.00
    const purchase = await service.request(
      {
        productId: "swiggy-in",
        packageId: "swiggy-500"
      },
      "Dinner for Friday",
      "telegram"
    );

    expect(purchase.id).toMatch(/^p_/);
    expect(purchase.status).toBe("APPROVED");
    expect(purchase.policyDecision).toBe("ALLOW");
    expect(purchase.priceCents).toBe(600);
    expect(purchase.simulatedSwap).toBe(true);

    const saved = service.get(purchase.id);
    expect(saved.id).toBe(purchase.id);
    expect(saved.status).toBe("APPROVED");
  });

  it("requires approval (AWAITING_APPROVAL) when price > $10 auto-approve limit", async () => {
    // steam-20 is $20.00 > $10.00 auto-approve threshold, <= $25 cap
    const purchase = await service.request(
      {
        productId: "steam-usd",
        packageId: "steam-20"
      },
      "Steam game for weekend",
      "agent"
    );

    expect(purchase.status).toBe("AWAITING_APPROVAL");
    expect(purchase.policyDecision).toBe("ASK");
    expect(purchase.approvalNonce).toBeDefined();
    expect(purchase.approvalExpiresAt).toBeDefined();
    expect(purchase.policyReasons[0]).toContain("above your auto-approve limit of $10.00");
  });

  it("DENYs purchase immediately when policy rules are violated (e.g. price > $25 cap)", async () => {
    // steam-50 is $50.00 > $25.00 hard cap
    const purchase = await service.request(
      {
        productId: "steam-usd",
        packageId: "steam-50"
      },
      "Excessive Steam spend",
      "agent"
    );

    expect(purchase.status).toBe("DENIED");
    expect(purchase.policyDecision).toBe("DENY");
    expect(purchase.policyReasons[0]).toContain("over your $25.00 per-purchase limit");
  });

  it("approves an AWAITING_APPROVAL purchase with correct nonce and transitions to APPROVED", async () => {
    const purchase = await service.request(
      {
        productId: "steam-usd",
        packageId: "steam-20"
      },
      "Approval test",
      "agent"
    );

    expect(purchase.status).toBe("AWAITING_APPROVAL");

    const approved = service.approve(purchase.id, "owner:telegram", purchase.approvalNonce || undefined);
    expect(approved.status).toBe("APPROVED");
  });

  it("fails approval if nonce does not match", async () => {
    const purchase = await service.request(
      {
        productId: "steam-usd",
        packageId: "steam-20"
      },
      "Nonce test",
      "agent"
    );

    expect(() => service.approve(purchase.id, "owner:telegram", "wrong_nonce")).toThrow(
      /Approval nonce mismatch/
    );
  });

  it("rejects an AWAITING_APPROVAL purchase and transitions to REJECTED", async () => {
    const purchase = await service.request(
      {
        productId: "steam-usd",
        packageId: "steam-20"
      },
      "Reject test",
      "agent"
    );

    expect(purchase.status).toBe("AWAITING_APPROVAL");

    const rejected = service.reject(purchase.id, "owner:telegram");
    expect(rejected.status).toBe("REJECTED");
  });

  it("re-evaluates policy at approval time and DENYs if spending was paused", async () => {
    const purchase = await service.request(
      {
        productId: "steam-usd",
        packageId: "steam-20"
      },
      "Pause test",
      "agent"
    );

    expect(purchase.status).toBe("AWAITING_APPROVAL");

    try {
      // Owner pauses system before approving
      policyStore.setPaused(true, "owner:telegram");

      expect(() => service.approve(purchase.id, "owner:telegram")).toThrow(/paused/i);

      const reloaded = service.get(purchase.id);
      expect(reloaded.status).toBe("DENIED");
    } finally {
      // Reset pause
      policyStore.setPaused(false, "owner:telegram");
    }
  });

  it("fails approval and expires purchase when approval_expires_at has elapsed", async () => {
    const purchase = await service.request(
      {
        productId: "steam-usd",
        packageId: "steam-20"
      },
      "Expiry test",
      "agent"
    );

    expect(purchase.status).toBe("AWAITING_APPROVAL");

    // Manually backdate approval_expires_at to 1 hour ago
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE purchases SET approval_expires_at = ? WHERE id = ?").run(
      oneHourAgo,
      purchase.id
    );

    expect(() => service.approve(purchase.id, "owner:telegram")).toThrow(
      /expired/i
    );

    const reloaded = service.get(purchase.id);
    expect(reloaded.status).toBe("EXPIRED");
  });

  it("calculates live budget correctly", async () => {
    const budget = await service.budget();
    expect(budget.paused).toBe(false);
    expect(budget.autoApproveUpToCents).toBe(1000);
    expect(budget.leftTodayCents).toBeLessThanOrEqual(5000);
    expect(budget.purchasesLeftToday).toBeLessThanOrEqual(5);
  });

  it("reveals decrypted code securely and records audit event", () => {
    const enc = encryptCode("TEST-GIFT-PIN-1234");
    const purchaseId = "p_with_code";
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO purchases (
        id, status, mode, source, product_id, product_name, product_type,
        face_value, face_currency, price_cents, price_source, quoted_zats,
        code_ciphertext, code_hash, created_at, updated_at
      ) VALUES (
        ?, 'DELIVERED', 'demo', 'agent', 'amazon-in', 'Amazon', 'giftcard',
        '500', 'INR', 600, 'fixed', 17000000,
        ?, ?, ?, ?
      )
    `).run(purchaseId, enc.ciphertext, enc.codeHash, now, now);

    const revealed = service.revealCode(purchaseId, "telegram");
    expect(revealed).toBe("TEST-GIFT-PIN-1234");

    const auditEvent = db
      .prepare("SELECT * FROM events WHERE purchase_id = ? AND type = 'code_revealed'")
      .get(purchaseId) as any;
    expect(auditEvent).toBeDefined();
    expect(auditEvent.actor).toBe("owner:telegram");
  });
});
