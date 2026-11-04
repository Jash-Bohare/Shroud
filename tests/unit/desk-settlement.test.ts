import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/db.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { PurchaseWorker } from "../../src/router/worker.js";
import { PurchaseRow, SETTLE_BITREFILL_BALANCE, SETTLE_TEST_PRODUCT } from "../../src/router/types.js";
import { parseListTxOutputs, parseZecAmountToZats } from "../../src/zcash/receipts.js";
import { VaultService } from "../../src/zcash/vault.js";

const balance = {
  totalZats: 100_000_000n, spendableZats: 100_000_000n, pendingZats: 0n, transparentZats: 0n,
  ironwoodSpendable: 100_000_000n, orchardSpendable: 0n, saplingSpendable: 0n, chainTipHeight: 1000
};

describe("devtool output parsing for desk matching", () => {
  it("parses TAZ amounts exactly (no floats)", () => {
    expect(parseZecAmountToZats("0.00010000 TAZ (Wallet Internal Transfer)")).toBe(10_000n);
    expect(parseZecAmountToZats("1.00000000 TAZ")).toBe(100_000_000n);
    expect(parseZecAmountToZats("0.0048 ZEC")).toBe(480_000n);
    expect(parseZecAmountToZats("Unknown")).toBeNull();
  });

  it("extracts the desk output with value, account and memo from real list-tx output", () => {
    const rows = parseListTxOutputs(readFileSync("tests/fixtures/devtool/list-tx.txt", "utf8"));
    const desk = rows.find((r) => r.memo === "SHROUD-DESK smoke-test");
    expect(desk).toMatchObject({
      txid: "6663bc4eb195d7a1adda095184da620f188a7de7c395f4d82cf7a386fbf2e075",
      minedHeight: 4562652,
      valueZats: 10_000n,
      receivedBy: "1f4c09f8-1676-4a0d-8e50-bdfdbb76894a"
    });
  });
});

function setup(opts: { orderMode: "test" | "balance"; deskPayment?: (memo: string) => any }) {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  runMigrations(db);
  const merchant = new MockMerchantAdapter();
  const calls = { balance: 0, test: 0 };
  const realBalanceOrder = merchant.placeBalanceOrder.bind(merchant);
  const realTestOrder = merchant.placeTestOrder.bind(merchant);
  merchant.placeBalanceOrder = async (sel) => { calls.balance++; return realBalanceOrder(sel); };
  merchant.placeTestOrder = async (sel, t) => { calls.test++; return realTestOrder(sel, t); };

  let lastPaid: { memo?: string; zats: bigint } | null = null;
  const vault = {
    getDeskAddress: async () => "utest1deskaddresstest",
    getBalance: async () => balance,
    sync: async () => {},
    findReceiptByAttempt: async () => null,
    payWithReceipt: async (input: any) => {
      lastPaid = { memo: input.toMemo, zats: input.zats };
      return { txid: "ab".repeat(32) };
    },
    findDeskPayment: async (memo: string) =>
      opts.deskPayment
        ? opts.deskPayment(memo)
        : lastPaid && lastPaid.memo === memo
          ? { txid: "ab".repeat(32), valueZats: lastPaid.zats, confirmations: 1 }
          : null
  } as unknown as VaultService;

  const executor = new DemoSwapExecutor({
    vault, merchant, amountScale: 1, minDemoZats: 10_000n, minConf: 1,
    orderMode: opts.orderMode, maxOrderCents: 1000, maxTotalCents: 1500, db
  });
  const policyStore = new PolicyStore(db);
  const svc = new PurchaseService({ db, merchant, pricing: new FixedPriceSource(35), executor, vault, policyStore, mode: "demo" });
  const worker = new PurchaseWorker({ db, vault, merchant, executor, policyStore, tickIntervalMs: 999_999 });
  const runToEnd = async (id: string) => {
    for (let i = 0; i < 10; i++) await worker.tick();
    return svc.get(id);
  };
  return { db, svc, runToEnd, calls };
}

describe("Desk settlement (testnet)", () => {
  it("balance mode: pays the full price, matches by memo, orders the REAL product", async () => {
    const t = setup({ orderMode: "balance" });
    const p = await t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "dinner", "agent");
    expect(p.status).toBe("APPROVED");
    expect(p.paidZats).toBe(p.quotedZats); // full price, not scaled
    expect(p.settlement).toBe("bitrefill-store-credit");
    expect(p.simulatedSwap).toBe(false);

    const done = await t.runToEnd(p.id);
    expect(done.status).toBe("DELIVERED");
    expect(t.calls).toEqual({ balance: 1, test: 0 });

    // No step of a real order is labelled simulated
    const sim = t.db.prepare("SELECT COUNT(*) AS c FROM events WHERE purchase_id = ? AND simulated = 1").get(p.id) as { c: bigint };
    expect(Number(sim.c)).toBe(0);
    const row = t.db.prepare("SELECT swap_ref FROM purchases WHERE id = ?").get(p.id) as { swap_ref: string };
    expect(row.swap_ref).toBe(SETTLE_BITREFILL_BALANCE);
  });

  it("test mode: orders the Bitrefill test product and labels settlement as simulated", async () => {
    const t = setup({ orderMode: "test" });
    const p = await t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "dinner", "agent");
    expect(p.settlement).toBe("bitrefill-test-product");
    expect(p.simulatedSwap).toBe(true);
    expect((await t.runToEnd(p.id)).status).toBe("DELIVERED");
    expect(t.calls).toEqual({ balance: 0, test: 1 });
    const row = t.db.prepare("SELECT swap_ref FROM purchases WHERE id = ?").get(p.id) as { swap_ref: string };
    expect(row.swap_ref).toBe(SETTLE_TEST_PRODUCT);
  });

  it("refuses a real order above the per-order cap before any payment", async () => {
    const t = setup({ orderMode: "balance" });
    // swiggy-1000 = $12.00 > $10.00 cap
    await expect(
      t.svc.request({ productId: "swiggy-in", packageId: "swiggy-1000" }, "big", "agent")
    ).rejects.toThrow("capped at $10.00");
    const rows = t.db.prepare("SELECT status, zec_txid FROM purchases").all() as any[];
    expect(rows).toEqual([{ status: "FAILED", zec_txid: null }]);
  });

  it("enforces the total store-credit budget across orders", async () => {
    const t = setup({ orderMode: "balance" });
    // $6 + $6 = $12 fits the $15 total; the third $6 would make $18
    for (let i = 0; i < 2; i++) {
      const p = await t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "x", "agent");
      expect((await t.runToEnd(p.id)).status).toBe("DELIVERED");
    }
    await expect(
      t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "x", "agent")
    ).rejects.toThrow("$3.00 left of $15.00");
    expect(t.calls.balance).toBe(2);
  });

  it("never fulfils an underpaid order", async () => {
    const t = setup({
      orderMode: "balance",
      deskPayment: () => ({ txid: "ab".repeat(32), valueZats: 1n, confirmations: 5 })
    });
    const p = await t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "x", "agent");
    expect((await t.runToEnd(p.id)).status).toBe("FAILED");
    expect(t.calls.balance).toBe(0);
  });

  it("waits (does not order) until the desk payment has the required confirmations", async () => {
    let confs = 0;
    const t = setup({
      orderMode: "balance",
      deskPayment: () => ({ txid: "ab".repeat(32), valueZats: 10n ** 12n, confirmations: confs })
    });
    const p = await t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "x", "agent");
    expect((await t.runToEnd(p.id)).status).toBe("SWAPPING");
    expect(t.calls.balance).toBe(0);
    confs = 1;
    expect((await t.runToEnd(p.id)).status).toBe("DELIVERED");
  });
});

describe("Quotes reflect the real-order cap", () => {
  it("get_quote says DENY with the cap reason, so the agent can't assume success", async () => {
    const t = setup({ orderMode: "balance" });
    const q = await t.svc.quote({ productId: "swiggy-in", packageId: "swiggy-1000" }); // $12 > $10
    expect(q.policy?.decision).toBe("DENY");
    expect(q.policy?.reasons.map((r) => r.rule)).toContain("REAL_ORDER_CAP");
    const ok = await t.svc.quote({ productId: "swiggy-in", packageId: "swiggy-500" }); // $6 fits
    expect(ok.policy?.decision).toBe("ALLOW");
  });

  it("test mode quotes are unaffected by store-credit caps", async () => {
    const t = setup({ orderMode: "test" });
    const q = await t.svc.quote({ productId: "swiggy-in", packageId: "swiggy-1000" });
    expect(q.policy?.reasons.map((r) => r.rule)).not.toContain("REAL_ORDER_CAP");
  });
});

describe("Real orders are placed at most once (no double charge)", () => {
  it("does not retry a real order that errored: FAILED after exactly one attempt", async () => {
    const t = setup({ orderMode: "balance" });
    const p = await t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "x", "agent");
    let attempts = 0;
    (t as any).merchantOverride = true;
    const merchant = (t.svc as any).merchant as MockMerchantAdapter;
    merchant.placeBalanceOrder = async () => {
      attempts++;
      throw new Error("socket hang up after charge");
    };
    const done = await t.runToEnd(p.id);
    expect(done.status).toBe("FAILED");
    expect(attempts).toBe(1);
  });

  it("resolves a late order id from the existing invoice instead of re-ordering", async () => {
    const t = setup({ orderMode: "balance" });
    const merchant = (t.svc as any).merchant as MockMerchantAdapter;
    let attempts = 0;
    let invoiceReads = 0;
    merchant.placeBalanceOrder = async () => {
      attempts++;
      return { invoiceId: "inv_late", orderId: "" }; // paid, order id not ready yet
    };
    const origGetInvoice = merchant.getInvoice.bind(merchant);
    merchant.getInvoice = async (id: string) => {
      invoiceReads++;
      return invoiceReads < 2 ? { status: "paid", orderIds: [] } : origGetInvoice(id);
    };
    const p = await t.svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "x", "agent");
    const done = await t.runToEnd(p.id);
    expect(done.status).toBe("DELIVERED");
    expect(attempts).toBe(1);
    expect(invoiceReads).toBeGreaterThanOrEqual(2);
  });
});

// Satisfy the PurchaseRow import for type-only usage in some TS configs
export type _Row = PurchaseRow;
