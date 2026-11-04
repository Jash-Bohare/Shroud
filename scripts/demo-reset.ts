import { getEnv } from "../src/config/env.js";
import { getDb, runMigrations } from "../src/db/db.js";
import { VaultConfig, VaultService } from "../src/zcash/vault.js";

async function appIsRunning(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== P5.1: Resetting Shroud Demo State ===");
  const envCfg = getEnv();

  // Two processes syncing the same wallet dir at once can corrupt it.
  if (await appIsRunning(envCfg.API_HOST, envCfg.API_PORT)) {
    console.error("Shroud is still running. Stop `npm run dev` (Ctrl+C) first, then re-run demo:reset.");
    process.exit(1);
  }

  const db = getDb();
  runMigrations(db);
  console.log(`   Database: ${envCfg.DB_PATH}`);

  console.log("1. Clearing database purchase records and event audit logs...");
  db.exec("DELETE FROM events;");
  db.exec("DELETE FROM purchases;");

  console.log("2. Resetting spending policy to hackathon demo defaults...");
  const defaultPolicy = {
    paused: false,
    maxPerPurchaseCents: 2500,        // $25.00 hard limit
    dailyLimitCents: 5000,            // $50.00 daily limit
    monthlyLimitCents: 20000,         // $200.00 monthly limit
    maxPurchasesPerDay: 5,            // 5 purchases / day
    requireApprovalAboveCents: 1000,  // $10.00 auto-approve threshold
    approveAllFirstTimeProducts: false,
    allowedTypes: ["giftcard", "esim", "refill", "bill"],
    allowedCountries: [],
    blockedProductIds: [],
    updatedAt: new Date().toISOString()
  };

  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify(defaultPolicy));

  console.log("3. Syncing Zcash shielded vault...");
  const env = getEnv();
  const vaultCfg: VaultConfig = {
    network: env.ZCASH_NETWORK as "test" | "main",
    vaultUuid: env.VAULT_ACCOUNT_UUID || "",
    receiptsUuid: env.RECEIPTS_ACCOUNT_UUID || "",
    deskUuid: env.DESK_ACCOUNT_UUID || "",
    receiptOutputZats: env.RECEIPT_OUTPUT_ZATS,
    maxSinglePaymentZats: env.MAX_SINGLE_PAYMENT_ZATS,
    identityFile: env.ZDT_IDENTITY_FILE
  };
  const vault = new VaultService(vaultCfg);
  await vault.sync();

  const bal = await vault.getBalance("vault");
  console.log(
    `   Vault Spendable: ${(Number(bal.spendableZats) / 100_000_000).toFixed(4)} ZEC (${bal.spendableZats} zats)`
  );
  console.log("=== Demo Reset Complete! Database fresh, policy seeded, wallet synced ===");
}

main().catch((err) => {
  console.error("Error resetting demo state:", err);
  process.exit(1);
});
