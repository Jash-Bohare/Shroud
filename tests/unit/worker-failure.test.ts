import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/db.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { PurchaseWorker } from "../../src/router/worker.js";
import { VaultService } from "../../src/zcash/vault.js";

describe("PurchaseWorker failure handling", () => {
  it("fails a purchase cleanly when payment keeps throwing after APPROVED -> PAYING", async () => {
    const db = new Database(":memory:");
    db.defaultSafeIntegers(true);
    runMigrations(db);
    const merchant = new MockMerchantAdapter();
    let payCalls = 0;
    const vault = {
      getDeskAddress: async () => "utest1deskaddresstest",
      getBalance: async () => ({
        totalZats: 100_000_000n, spendableZats: 100_000_000n, pendingZats: 0n, transparentZats: 0n,
        ironwoodSpendable: 100_000_000n, orchardSpendable: 0n, saplingSpendable: 0n, chainTipHeight: 1
      }),
      payWithReceipt: async () => {
        payCalls++;
        throw new Error("lightwalletd unreachable");
      },
      findReceiptByAttempt: async () => null,
      sync: async () => {}
    } as unknown as VaultService;
    const executor = new DemoSwapExecutor({ vault, merchant, amountScale: 0.01, minDemoZats: 10_000n });
    const policyStore = new PolicyStore(db);
    const svc = new PurchaseService({ db, merchant, pricing: new FixedPriceSource(35), executor, vault, policyStore, mode: "demo" });
    const worker = new PurchaseWorker({ db, vault, merchant, executor, policyStore, tickIntervalMs: 999_999 });

    const p = await svc.request({ productId: "swiggy-in", packageId: "swiggy-500" }, "t", "agent");
    expect(p.status).toBe("APPROVED");

    for (let i = 0; i < 8; i++) await worker.tick();

    const final = svc.get(p.id);
    expect(final.status).toBe("FAILED");
    expect(payCalls).toBe(5); // maxRetries, then stops
  });
});
