import Database from "better-sqlite3";
import { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "../../src/api/server.js";
import { runMigrations } from "../../src/db/db.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { VaultService } from "../../src/zcash/vault.js";

const TOKEN = "hardening_token_abc";
const rec = (id: string, h: number | null) => ({
  txid: id.padEnd(64, "0").slice(0, 64),
  minedHeight: h,
  receipt: { v: 1, id, a: `a_${id}`, t: 1, m: "demo", p: "x", n: id, fv: "1", fc: "USD", u: 100, z: "10000", x: "desk" }
});

describe("API hardening", () => {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  runMigrations(db);
  const policyStore = new PolicyStore(db);
  const merchant = new MockMerchantAdapter();
  const vault = {
    getDeskAddress: async () => "utest1deskaddresstest",
    getBalance: async () => ({
      totalZats: 100_000_000n, spendableZats: 100_000_000n, pendingZats: 0n, transparentZats: 0n,
      ironwoodSpendable: 100_000_000n, orchardSpendable: 0n, saplingSpendable: 0n, chainTipHeight: 1
    }),
    listReceipts: async () => [rec("p_a", 10), rec("p_b", 30), rec("p_pending", null), rec("p_c", 20)]
  } as unknown as VaultService;
  const executor = new DemoSwapExecutor({ vault, merchant, amountScale: 0.01, minDemoZats: 10_000n });
  const purchaseService = new PurchaseService({
    db, merchant, pricing: new FixedPriceSource(35), executor, vault, policyStore, mode: "demo"
  });
  const app = createApiApp({ db, vault, purchaseService, policyStore, merchant, dashboardToken: TOKEN });

  let server: Server;
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        r();
      });
    });
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  it("rejects wrong tokens, including ones of a different length", async () => {
    for (const bad of ["", "x", `${TOKEN}x`, TOKEN.slice(0, -1) + "Z"]) {
      const res = await fetch(`${base}/api/policy`, { headers: { Authorization: `Bearer ${bad}` } });
      expect(res.status).toBe(401);
    }
    expect((await fetch(`${base}/api/policy`, { headers: auth })).status).toBe(200);
  });

  it("returns 400 for a purchase body without productId (never reaches the merchant)", async () => {
    const res = await fetch(`${base}/api/purchases`, { method: "POST", headers: auth, body: JSON.stringify({ value: 5 }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("productId");
    const count = db.prepare("SELECT COUNT(*) AS c FROM purchases").get() as { c: bigint };
    expect(Number(count.c)).toBe(0);
  });

  it("rejects unknown fields in purchase and quote bodies", async () => {
    const body = JSON.stringify({ productId: "swiggy-in", packageId: "swiggy-500", payTo: "utest1attacker" });
    expect((await fetch(`${base}/api/purchases`, { method: "POST", headers: auth, body })).status).toBe(400);
    expect((await fetch(`${base}/api/quotes`, { method: "POST", headers: auth, body })).status).toBe(400);
  });

  it("returns receipts newest first with unmined at the top", async () => {
    const res = await fetch(`${base}/api/receipts`, { headers: auth });
    const ids = (await res.json()).items.map((r: any) => r.receipt.id);
    expect(ids).toEqual(["p_pending", "p_b", "p_c", "p_a"]);
  });
});

describe("PurchaseService does not strand rows when preparation fails", () => {
  it("moves the purchase to FAILED if the desk address lookup throws", async () => {
    const db = new Database(":memory:");
    db.defaultSafeIntegers(true);
    runMigrations(db);
    const merchant = new MockMerchantAdapter();
    const vault = {
      getDeskAddress: async () => {
        throw new Error("devtool unavailable");
      }
    } as unknown as VaultService;
    const svc = new PurchaseService({
      db, merchant, pricing: new FixedPriceSource(35),
      executor: new DemoSwapExecutor({ vault, merchant, amountScale: 0.01, minDemoZats: 10_000n }),
      vault, policyStore: new PolicyStore(db), mode: "demo"
    });
    await expect(svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "t", "agent")).rejects.toThrow(
      "devtool unavailable"
    );
    const rows = db.prepare("SELECT status FROM purchases").all() as { status: string }[];
    expect(rows.map((r) => r.status)).toEqual(["FAILED"]);
  });
});
