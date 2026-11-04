import { getEnv } from "../src/config/env.js";
import { VaultService, VaultConfig } from "../src/zcash/vault.js";
import { centsToUsd, zatsToZec } from "../src/shared/money.js";

async function main() {
  console.log("=== SMOKE TEST: Zcash Shielded Vault ===");
  const env = getEnv();

  if (!env.VAULT_ACCOUNT_UUID || !env.RECEIPTS_ACCOUNT_UUID || !env.DESK_ACCOUNT_UUID) {
    console.warn("Account UUIDs are not yet set in .env. Run 'npx tsx scripts/setup-wallet.ts' first.");
    return;
  }

  const vaultCfg: VaultConfig = {
    network: env.ZCASH_NETWORK as "test" | "main",
    vaultUuid: env.VAULT_ACCOUNT_UUID,
    receiptsUuid: env.RECEIPTS_ACCOUNT_UUID,
    deskUuid: env.DESK_ACCOUNT_UUID,
    receiptOutputZats: env.RECEIPT_OUTPUT_ZATS,
    maxSinglePaymentZats: env.MAX_SINGLE_PAYMENT_ZATS,
    identityFile: env.ZDT_IDENTITY_FILE
  };

  const vault = new VaultService(vaultCfg);

  // 1. Health check
  console.log("1. Checking vault health...");
  const health = await vault.health();
  console.log(`   Health: ${health.ok ? "OK" : "FAILED"} (Network: ${health.network})`);
  if (!health.ok) {
    console.error("   Error:", health.message);
    process.exit(1);
  }

  // 2. Sync
  console.log("\n2. Syncing wallet with lightwalletd...");
  await vault.sync();
  console.log("   Sync completed.");

  // 3. Addresses
  console.log("\n3. Account Addresses:");
  const vaultAddress = await vault.getFundingAddress();
  const receiptsAddress = await vault.getReceiptsAddress();
  const deskAddress = await vault.getDeskAddress();
  console.log(" - Vault Funding Address:   ", vaultAddress);
  console.log(" - Receipts Shielded Address:", receiptsAddress);
  console.log(" - Demo Desk Address:        ", deskAddress);

  // 4. Balances
  console.log("\n4. Balances:");
  const vaultBal = await vault.getBalance("vault");
  const receiptsBal = await vault.getBalance("receipts");
  const deskBal = await vault.getBalance("desk");

  console.log(` - Vault:    Spendable: ${zatsToZec(vaultBal.spendableZats)} ZEC (${vaultBal.spendableZats} zats) | Pending: ${zatsToZec(vaultBal.pendingZats)} ZEC`);
  console.log(` - Receipts: Total:     ${zatsToZec(receiptsBal.totalZats)} ZEC`);
  console.log(` - Desk:     Total:     ${zatsToZec(deskBal.totalZats)} ZEC`);

  // 5. Test Payment (if spendable balance >= 60,000 zats)
  const minRequired = 60_000n;
  if (vaultBal.spendableZats >= minRequired) {
    console.log("\n5. Executing test payment of 10,000 zats to desk with SHRD1 receipt memo...");
    const attemptId = `att_smoke_${Date.now()}`;
    const payResult = await vault.payWithReceipt({
      to: deskAddress,
      zats: 10_000n,
      toMemo: "SHROUD-DESK smoke-test",
      attemptId,
      receipt: {
        id: `p_smoke_${Date.now()}`,
        attemptId,
        mode: "demo",
        productId: "test-card",
        productName: "Smoke Test Card",
        faceValue: "1",
        faceCurrency: "USD",
        priceCents: 100,
        zatsPaid: 10_000n,
        swapRef: "desk"
      }
    });

    console.log(`   Transaction broadcast! TXID: ${payResult.txid}`);
    console.log("   Waiting for at least 1 confirmation...");

    let confs = 0;
    while (confs < 1) {
      await new Promise((r) => setTimeout(r, 10_000));
      await vault.sync();
      const count = await vault.getTxConfirmations(payResult.txid, "desk");
      confs = count ?? 0;
      console.log(`   Confirmations: ${confs}`);
    }

    console.log("\n6. Reading receipts on-chain from receipts account...");
    const receipts = await vault.listReceipts();
    console.log(`   Found ${receipts.length} decoded on-chain receipts.`);
    const latest = receipts[receipts.length - 1];
    if (latest) {
      console.log("   Latest Receipt Details:", JSON.stringify(latest.receipt, null, 2));
    }
  } else {
    console.log("\nVault spendable balance is less than 0.0006 ZEC.");
    console.log("Please top up the vault at the funding address above to run live transaction tests.");
  }

  console.log("\n=== ZCASH SMOKE TEST COMPLETED ===");
}

main().catch((err) => {
  console.error("Error in smoke:zcash:", err);
  process.exit(1);
});

