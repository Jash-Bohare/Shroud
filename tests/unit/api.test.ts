import Database from "better-sqlite3";
import express from "express";
import { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "../../src/api/server.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { encryptCode } from "../../src/shared/crypto.js";
import { ReceiptRecord } from "../../src/zcash/receipts.js";
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

describe("REST API (Dashboard)", () => {
  const testToken = "test_secret_token_12345";
  const db = setupTestDb();
  const policyStore = new PolicyStore(db);
  const merchant = new MockMerchantAdapter();
  const pricing = new FixedPriceSource(35);

  const mockReceipts: ReceiptRecord[] = [
    {
      txid: "00755b8eec3932954f021907ef8eaf40a50031912dac68644f95240eff5520af",
      minedHeight: 4562780,
      receipt: {
        v: 1,
        id: "p_test_receipt",
        a: "att_test_1",
        t: 1793441289,
        m: "demo",
        p: "test-gift-card-code",
        n: "Test Gift Card Code",
        fv: "10",
        fc: "USD",
        u: 1000,
        z: "10000",
        x: "desk"
      }
    }
  ];

  const fakeVault = {
    getFundingAddress: async () => "utest1testfundingaddress",
    getReceiptsAddress: async () => "utest1testreceiptsaddress",
    getDeskAddress: async () => "utest1deskaddresstest",
    sync: async () => {},
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
    listReceipts: async () => mockReceipts
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

  const app = createApiApp({
    db,
    vault: fakeVault,
    purchaseService,
    policyStore,
    merchant,
    pricing,
    dashboardToken: testToken
  });

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("serves public GET /health without authentication", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.version).toBe("0.1.0");
  });

  it("rejects protected endpoints with 401 when token is missing", async () => {
    const res = await fetch(`${baseUrl}/api/policy`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects protected endpoints with 401 when token is invalid", async () => {
    const res = await fetch(`${baseUrl}/api/policy`, {
      headers: { Authorization: "Bearer wrong_token" }
    });
    expect(res.status).toBe(401);
  });

  it("serves GET /api/policy with valid token", async () => {
    const res = await fetch(`${baseUrl}/api/policy`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.paused).toBe(false);
    expect(p.dailyLimitCents).toBe(5000);
  });

  it("updates policy via PUT /api/policy", async () => {
    const res = await fetch(`${baseUrl}/api/policy`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ dailyLimitCents: 7500 })
    });
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.dailyLimitCents).toBe(7500);
  });

  it("pauses and resumes policy via POST /api/policy/pause and /resume", async () => {
    const pauseRes = await fetch(`${baseUrl}/api/policy/pause`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(pauseRes.status).toBe(200);
    expect((await pauseRes.json()).paused).toBe(true);

    const resumeRes = await fetch(`${baseUrl}/api/policy/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).paused).toBe(false);
  });

  it("serves GET /api/budget", async () => {
    const res = await fetch(`${baseUrl}/api/budget`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.paused).toBe(false);
    expect(b.autoApproveUpToCents).toBe(1000);
  });

  it("serves GET /api/receipts with on-chain receipts", async () => {
    const res = await fetch(`${baseUrl}/api/receipts`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].txid).toBe(mockReceipts[0].txid);
    expect(data.items[0].receipt.id).toBe("p_test_receipt");
  });

  it("handles purchase approval and code reveal flow via API", async () => {
    // 1. Create a purchase needing approval
    const purchase = await purchaseService.request(
      { productId: "steam-usd", packageId: "steam-20" },
      "API test",
      "agent"
    );
    expect(purchase.status).toBe("AWAITING_APPROVAL");

    // 2. Fetch purchase via GET /api/purchases/:id
    const getRes = await fetch(`${baseUrl}/api/purchases/${purchase.id}`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(purchase.id);

    // 3. Approve via POST /api/purchases/:id/approve
    const approveRes = await fetch(`${baseUrl}/api/purchases/${purchase.id}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ nonce: purchase.approvalNonce })
    });
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe("APPROVED");

    // 4. Test code reveal with mock encrypted code
    const enc = encryptCode("SECRET-REDEEM-9999");
    db.prepare(`
      INSERT INTO purchases (
        id, status, mode, source, product_id, product_name, product_type,
        face_value, face_currency, price_cents, price_source, quoted_zats,
        code_ciphertext, code_hash, created_at, updated_at
      ) VALUES (
        'p_ready_for_reveal', 'DELIVERED', 'demo', 'agent', 'steam-usd', 'Steam', 'giftcard',
        '20', 'USD', 2000, 'fixed', 57000000,
        ?, ?, datetime('now'), datetime('now')
      )
    `).run(enc.ciphertext, enc.codeHash);

    const revealRes = await fetch(`${baseUrl}/api/purchases/p_ready_for_reveal/reveal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(revealRes.status).toBe(200);
    const revealData = await revealRes.json();
    expect(revealData.code).toBe("SECRET-REDEEM-9999");
  });

  it("serves GET /api/wallet and POST /api/wallet/sync", async () => {
    const walletRes = await fetch(`${baseUrl}/api/wallet`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(walletRes.status).toBe(200);
    const walletData = await walletRes.json();
    expect(walletData.fundingAddress).toBe("utest1testfundingaddress");
    expect(walletData.receiptsAddress).toBe("utest1testreceiptsaddress");
    expect(walletData.balance.spendableZats).toBe("100000000");
    expect(walletData.balance.spendableZec).toBe("1.0000");

    const syncRes = await fetch(`${baseUrl}/api/wallet/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(syncRes.status).toBe(200);
    const syncData = await syncRes.json();
    expect(syncData.ok).toBe(true);
    expect(typeof syncData.durationMs).toBe("number");
  });

  it("serves catalog search, product details, and quotes", async () => {
    // 1. Search products
    const searchRes = await fetch(`${baseUrl}/api/products/search?q=steam`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(searchRes.status).toBe(200);
    const searchData = await searchRes.json();
    expect(Array.isArray(searchData.results)).toBe(true);
    expect(searchData.results.length).toBeGreaterThan(0);

    // 2. Get product
    const prodRes = await fetch(`${baseUrl}/api/products/steam-usd`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(prodRes.status).toBe(200);
    const prodData = await prodRes.json();
    expect(prodData.id).toBe("steam-usd");

    // 3. Get quote
    const quoteRes = await fetch(`${baseUrl}/api/quotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ productId: "steam-usd", packageId: "steam-20" })
    });
    expect(quoteRes.status).toBe(200);
    const quoteData = await quoteRes.json();
    expect(quoteData.priceCents).toBe(2000);
    expect(quoteData.priceUsd).toBe("$20.00");
  });

  it("creates dashboard purchases with reason and returns event timeline", async () => {
    const createRes = await fetch(`${baseUrl}/api/purchases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        productId: "steam-usd",
        packageId: "steam-20",
        reason: "Manual test purchase from dashboard"
      })
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.source).toBe("dashboard");
    expect(created.reason).toBe("Manual test purchase from dashboard");

    // Fetch purchase with events timeline
    const getRes = await fetch(`${baseUrl}/api/purchases/${created.id}`, {
      headers: { Authorization: `Bearer ${testToken}` }
    });
    expect(getRes.status).toBe(200);
    const withEvents = await getRes.json();
    expect(Array.isArray(withEvents.events)).toBe(true);
    expect(withEvents.events.length).toBeGreaterThan(0);
    expect(withEvents.events[0].actor).toBeDefined();
  });

  it("streams events over SSE via GET /api/events/stream", async () => {
    const controller = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/events/stream`, {
      headers: { Authorization: `Bearer ${testToken}` },
      signal: controller.signal
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Close stream
    controller.abort();
  });
});

