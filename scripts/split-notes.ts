import { getEnv } from "../src/config/env.js";
import { VaultConfig, VaultService } from "../src/zcash/vault.js";

async function main() {
  console.log("=== P5.2: Splitting Vault Notes to Prevent Change Waits ===");
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

  console.log("1. Syncing wallet...");
  await vault.sync();

  const bal = await vault.getBalance("vault");
  console.log(`   Vault spendable: ${(Number(bal.spendableZats) / 100_000_000).toFixed(4)} ZEC (${bal.spendableZats} zats)`);

  const fundingAddr = await vault.getFundingAddress();
  console.log(`   Vault address:   ${fundingAddr}`);

  // Split into 3 independent notes of 50,000 zats each (~$0.0175 USD each)
  const splitAmount = 50_000n;
  const numNotes = 3;

  console.log(`2. Sending ${numNotes} self-transfers of ${splitAmount} zats each...`);
  for (let i = 1; i <= numNotes; i++) {
    console.log(`   [${i}/${numNotes}] Sending self-transfer...`);
    try {
      const res = await vault.pay({
        to: fundingAddr,
        zats: splitAmount,
        receipt: {
          id: `p_split_${i}`,
          attemptId: `att_split_${i}`,
          mode: "demo",
          productId: "vault-split",
          productName: `Vault Note Split ${i}`,
          faceValue: "0.01",
          faceCurrency: "USD",
          priceCents: 1,
          paidZats: splitAmount,
          exchangeMethod: "self"
        }
      });
      console.log(`   [${i}/${numNotes}] Success! TXID: ${res.txid}`);
    } catch (err: any) {
      console.warn(`   [${i}/${numNotes}] Note send warning: ${err.message}`);
    }
  }

  console.log("3. Syncing after self-transfers...");
  await vault.sync();
  const finalBal = await vault.getBalance("vault");
  console.log(`   Final Vault Spendable: ${(Number(finalBal.spendableZats) / 100_000_000).toFixed(4)} ZEC`);
  console.log("=== Vault Note Splitting Complete ===");
}

main().catch((err) => {
  console.error("Error in split-notes:", err);
  process.exit(1);
});

