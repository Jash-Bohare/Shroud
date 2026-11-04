import { getEnv } from "../src/config/env.js";
import { getDb, runMigrations } from "../src/db/db.js";
import { BitrefillMerchantAdapter } from "../src/merchant/bitrefill.js";
import { MockMerchantAdapter } from "../src/merchant/mock.js";
import { MerchantAdapter } from "../src/merchant/types.js";
import { PricingService } from "../src/pricing/service.js";
import { DemoSwapExecutor } from "../src/router/demo-swap.js";
import { PurchaseService } from "../src/router/purchase-service.js";
import { PurchaseWorker } from "../src/router/worker.js";
import { VaultConfig, VaultService } from "../src/zcash/vault.js";

async function main() {
  console.log("=== SMOKE TEST: End-to-End Demo Purchase Pipeline ===");
  const env = getEnv();

  // 1. Ensure migrations are up to date
  runMigrations(getDb());

  // 2. Initialize Vault
  const vaultCfg: VaultConfig = {
    network: env.ZCASH_NETWORK as "test" | "main",
    vaultUuid: env.VAULT_ACCOUNT_UUID!,
    receiptsUuid: env.RECEIPTS_ACCOUNT_UUID!,
    deskUuid: env.DESK_ACCOUNT_UUID!,
    receiptOutputZats: env.RECEIPT_OUTPUT_ZATS,
    maxSinglePaymentZats: env.MAX_SINGLE_PAYMENT_ZATS,
    identityFile: env.ZDT_IDENTITY_FILE
  };
  const vault = new VaultService(vaultCfg);

  // Sync vault
  console.log("1. Syncing wallet with Zcash testnet...");
  await vault.sync();
  const bal = await vault.getBalance("vault");
  console.log(`   Vault spendable: ${bal.spendableZats} zats`);

  if (bal.spendableZats < 30_000n) {
    console.error("Vault needs at least 30,000 zats for test transaction. Please claim from fauzec.com.");
    process.exit(1);
  }

  // 3. Initialize Merchant Adapter
  let merchant: MerchantAdapter;
  if (env.BITREFILL_MODE === "mock" || !env.BITREFILL_API_KEY) {
    console.log("2. Using MockMerchantAdapter");
    merchant = new MockMerchantAdapter();
  } else {
    console.log("2. Using live BitrefillMerchantAdapter (API)");
    merchant = new BitrefillMerchantAdapter();
  }

  // 4. Initialize Pricing & Router
  const pricing = new PricingService();
  const executor = new DemoSwapExecutor({
    vault,
    merchant,
    amountScale: env.DEMO_AMOUNT_SCALE,
    minDemoZats: env.MIN_DEMO_ZATS,
    minConf: 1
  });

  const purchaseService = new PurchaseService({
    merchant,
    pricing,
    executor,
    vault,
    mode: "demo"
  });

  const worker = new PurchaseWorker({
    vault,
    merchant,
    executor
  });

  // 5. Request a purchase
  const productId = "test-gift-card-code";
  console.log(`\n3. Requesting purchase for "${productId}" ($10 USD)...`);
  const purchase = await purchaseService.request(
    { productId, value: 10 },
    "End-to-end Phase 2 smoke verification",
    "dashboard"
  );

  console.log(`   Created purchase: ${purchase.id}`);
  console.log(`   Status:           ${purchase.status}`);
  console.log(`   Price:            ${purchase.priceUsd} (${purchase.quotedZats} quoted zats)`);
  console.log(`   Demo scaled pay:  ${purchase.paidZats} zats`);

  // 6. Advance with worker ticks until DELIVERED or FAILED
  console.log("\n4. Worker advancing purchase through lifecycle...");
  let current = purchaseService.get(purchase.id);
  let ticks = 0;
  const maxTicks = 30;

  while (current.status !== "DELIVERED" && current.status !== "FAILED" && ticks < maxTicks) {
    ticks++;
    await worker.tick();
    current = purchaseService.get(purchase.id);
    console.log(`   [Tick ${ticks}] Status: ${current.status}${current.zecTxid ? ` (TX: ${current.zecTxid.slice(0, 16)}...)` : ""}`);

    if (current.status === "SWAPPING") {
      console.log("   Waiting for testnet block confirmation (approx 15-45s)...");
      await new Promise((r) => setTimeout(r, 10_000));
      await vault.sync();
    } else if (current.status !== "DELIVERED" && current.status !== "FAILED") {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (current.status !== "DELIVERED") {
    console.error(`\nPurchase did not reach DELIVERED (ended with status: ${current.status})`);
    process.exit(1);
  }

  // 7. Reveal Code
  console.log("\n5. Revealing decrypted redemption code...");
  const code = purchaseService.revealCode(purchase.id, "dashboard");
  console.log(`   ✅ Redeemed Code: ${code}`);

  // 8. Read On-Chain Receipts
  console.log("\n6. Reading receipts on-chain from shielded receipts account...");
  const receipts = await vault.listReceipts();
  const matching = receipts.find((r) => r.receipt.id === purchase.id);
  if (matching) {
    console.log("   ✅ Confirmed on-chain receipt found!");
    console.log("   Receipt on-chain details:", JSON.stringify(matching.receipt, null, 2));
  } else {
    console.log(`   Found ${receipts.length} total receipts on-chain.`);
  }

  console.log("\n=== E2E PURCHASE SMOKE TEST PASSED SUCCESSFULLY ===");
}

main().catch((err) => {
  console.error("Error in smoke:purchase:", err);
  process.exit(1);
});
