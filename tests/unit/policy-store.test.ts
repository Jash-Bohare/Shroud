import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { computeSpendState } from "../../src/policy/spend-state.js";
import { PolicyStore } from "../../src/policy/store.js";
import { eventBus } from "../../src/router/events.js";

function createTestDb(): Database.Database {
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

describe("PolicyStore", () => {
  it("initializes with default policy when database is empty", () => {
    const db = createTestDb();
    const store = new PolicyStore(db);
    const p = store.get();
    expect(p.paused).toBe(false);
    expect(p.dailyLimitCents).toBe(5000);
    expect(p.allowedTypes).toEqual(["giftcard", "esim", "refill"]);
  });

  it("updates policy patch, writes audit event, and emits event", () => {
    const db = createTestDb();
    const store = new PolicyStore(db);

    let emittedPolicy: any = null;
    eventBus.once("policy", (p) => {
      emittedPolicy = p;
    });

    const updated = store.update({ dailyLimitCents: 8000, maxPurchasesPerDay: 10 }, "dashboard");
    expect(updated.dailyLimitCents).toBe(8000);
    expect(updated.maxPurchasesPerDay).toBe(10);
    expect(emittedPolicy?.dailyLimitCents).toBe(8000);

    const event = db.prepare("SELECT * FROM events WHERE type = 'policy_updated'").get() as any;
    expect(event).toBeDefined();
    expect(event.actor).toBe("dashboard");
  });

  it("toggles paused flag with setPaused", () => {
    const db = createTestDb();
    const store = new PolicyStore(db);
    const p = store.setPaused(true, "owner:telegram");
    expect(p.paused).toBe(true);
    expect(store.get().paused).toBe(true);
  });

  it("rejects invalid patches with Zod validation error", () => {
    const db = createTestDb();
    const store = new PolicyStore(db);
    expect(() => store.update({ dailyLimitCents: -500 }, "dashboard")).toThrow();
  });
});

describe("computeSpendState", () => {
  it("computes 24h and 30d spend and counts only committed statuses", () => {
    const db = createTestDb();
    const now = new Date("2026-10-31T12:00:00Z");

    const insertStmt = db.prepare(`
      INSERT INTO purchases (
        id, status, mode, source, product_id, product_name, product_type,
        face_value, face_currency, price_cents, price_source, quoted_zats,
        zec_txid, created_at, updated_at
      ) VALUES (?, ?, 'demo', 'agent', ?, 'Test', 'giftcard', '10', 'USD', ?, 'fixed', 10000, ?, ?, ?)
    `);

    // 1. Counted purchase today ($15)
    insertStmt.run("p1", "DELIVERED", "prod_a", 1500, "tx1", "2026-10-31T10:00:00Z", "2026-10-31T10:00:00Z");
    // 2. Counted purchase today ($10)
    insertStmt.run("p2", "APPROVED", "prod_b", 1000, null, "2026-10-31T08:00:00Z", "2026-10-31T08:00:00Z");
    // 3. Ignored purchase today (AWAITING_APPROVAL - money not committed)
    insertStmt.run("p3", "AWAITING_APPROVAL", "prod_c", 2000, null, "2026-10-31T09:00:00Z", "2026-10-31T09:00:00Z");
    // 4. Ignored purchase today (DENIED)
    insertStmt.run("p4", "DENIED", "prod_d", 5000, null, "2026-10-31T09:30:00Z", "2026-10-31T09:30:00Z");
    // 5. Counted purchase 5 days ago ($25)
    insertStmt.run("p5", "DELIVERED", "prod_a", 2500, "tx2", "2026-10-26T12:00:00Z", "2026-10-26T12:00:00Z");
    // 6. Old purchase 40 days ago ($50 - outside 30d)
    insertStmt.run("p6", "DELIVERED", "prod_e", 5000, "tx3", "2026-09-15T12:00:00Z", "2026-09-15T12:00:00Z");
    // 7. FAILED with txid (funds broadcasted on-chain - counted)
    insertStmt.run("p7", "FAILED", "prod_f", 500, "tx4", "2026-10-31T11:00:00Z", "2026-10-31T11:00:00Z");
    // 8. FAILED without txid (not broadcasted - not counted)
    insertStmt.run("p8", "FAILED", "prod_g", 700, null, "2026-10-31T11:30:00Z", "2026-10-31T11:30:00Z");

    const spend = computeSpendState(db, now, 100_000_000n, 50_000n);

    // 24h spend: p1 (1500) + p2 (1000) + p7 (500) = 3000 cents ($30.00), 3 purchases
    expect(spend.spentLast24hCents).toBe(3000);
    expect(spend.purchasesLast24h).toBe(3);

    // 30d spend: p1 (1500) + p2 (1000) + p5 (2500) + p7 (500) = 5500 cents ($55.00)
    expect(spend.spentLast30dCents).toBe(5500);

    // Previously bought products
    expect(spend.previouslyBoughtProductIds.has("prod_a")).toBe(true);
    expect(spend.previouslyBoughtProductIds.has("prod_b")).toBe(true);
    expect(spend.previouslyBoughtProductIds.has("prod_f")).toBe(true);
    expect(spend.previouslyBoughtProductIds.has("prod_c")).toBe(false); // AWAITING_APPROVAL not counted
    expect(spend.previouslyBoughtProductIds.has("prod_g")).toBe(false); // FAILED without txid not counted
  });
});

