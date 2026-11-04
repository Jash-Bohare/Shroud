import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "../src/config/env.js";
import { runDevtool, parseAccounts, parseUnifiedAddress } from "../src/zcash/devtool.js";
import qrcode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log("=== SHROUD: WALLET INITIALIZATION ===");
  const env = getEnv();

  const walletDir = env.ZDT_WALLET_DIR;
  const identityFile = env.ZDT_IDENTITY_FILE;
  const network = env.ZCASH_NETWORK;

  if (!existsSync(dirname(identityFile))) {
    mkdirSync(dirname(identityFile), { recursive: true });
  }
  if (!existsSync(walletDir)) {
    mkdirSync(walletDir, { recursive: true });
  }

  // 1. Check if wallet directory has an existing database
  const isExisting = existsSync(join(walletDir, "wallet.sqlite3")) || existsSync(join(walletDir, "zcash-devtool.sqlite3"));

  if (!isExisting) {
    console.log(`1. Initializing new testnet vault in: ${walletDir}`);
    console.log(`   Identity key file: ${identityFile}`);
    console.log("------------------------------------------------------------------");
    console.log("IMPORTANT: The seed phrase will be displayed below. Write it down.");
    console.log("------------------------------------------------------------------");

    const initRes = await runDevtool([
      "init",
      "--name",
      "vault",
      "-i",
      identityFile,
      "-n",
      network
    ]);
    console.log(initRes.stdout);
  } else {
    console.log(`Wallet already exists at ${walletDir}. Skipping init.`);
  }

  // 2. Initial Sync
  console.log("\n2. Synchronizing wallet with testnet...");
  try {
    await runDevtool(["sync"], { timeoutMs: 120_000 });
    console.log("   Sync complete.");
  } catch (err: any) {
    console.warn("   Initial sync warning (can be re-synced later):", err.message);
  }

  // 3. List accounts and create missing accounts
  let accountsRes = await runDevtool(["list-accounts"]);
  let accounts = parseAccounts(accountsRes.stdout);

  let vaultAcc = accounts.find((a) => a.name === "vault");
  let receiptsAcc = accounts.find((a) => a.name === "receipts");
  let deskAcc = accounts.find((a) => a.name === "desk");

  if (!receiptsAcc) {
    console.log("\n3. Creating receipts account...");
    await runDevtool(["generate-account", "-i", identityFile, "--name", "receipts"]);
    accountsRes = await runDevtool(["list-accounts"]);
    accounts = parseAccounts(accountsRes.stdout);
    receiptsAcc = accounts.find((a) => a.name === "receipts");
  }

  if (!deskAcc) {
    console.log("\n4. Creating demo swap desk account...");
    await runDevtool(["generate-account", "-i", identityFile, "--name", "desk"]);
    accountsRes = await runDevtool(["list-accounts"]);
    accounts = parseAccounts(accountsRes.stdout);
    deskAcc = accounts.find((a) => a.name === "desk");
  }

  console.log("\nAccounts discovered:");
  console.log(" - Vault Account UUID:   ", vaultAcc?.uuid);
  console.log(" - Receipts Account UUID:", receiptsAcc?.uuid);
  console.log(" - Desk Account UUID:    ", deskAcc?.uuid);

  // 4. Update .env file with UUIDs
  const envPath = join(__dirname, "../.env");
  if (existsSync(envPath) && vaultAcc && receiptsAcc && deskAcc) {
    let envContent = readFileSync(envPath, "utf-8");
    envContent = envContent.replace(/^VAULT_ACCOUNT_UUID=.*$/m, `VAULT_ACCOUNT_UUID=${vaultAcc.uuid}`);
    envContent = envContent.replace(/^RECEIPTS_ACCOUNT_UUID=.*$/m, `RECEIPTS_ACCOUNT_UUID=${receiptsAcc.uuid}`);
    envContent = envContent.replace(/^DESK_ACCOUNT_UUID=.*$/m, `DESK_ACCOUNT_UUID=${deskAcc.uuid}`);
    writeFileSync(envPath, envContent);
    console.log("\nUpdated .env with account UUIDs automatically.");
  }

  // 5. Get funding address
  if (vaultAcc) {
    console.log("\n5. Deriving Vault Funding Address (Unified Address)...");
    const addrRes = await runDevtool(["list-addresses", vaultAcc.uuid]);
    const fundingAddress = parseUnifiedAddress(addrRes.stdout);

    console.log("\n=======================================================");
    console.log("YOUR SHROUD VAULT FUNDING ADDRESS (TESTNET):");
    console.log(fundingAddress);
    console.log("=======================================================\n");

    try {
      const qrAscii = await qrcode.toString(fundingAddress, { type: "terminal", small: true });
      console.log(qrAscii);
    } catch {
      // ignore qr rendering errors
    }

    console.log("NEXT STEP: Claim free testnet coins (TAZ) to this address from:");
    console.log(" -> https://fauzec.com");
    console.log(" -> https://zcashfaucet.jinolabs.xyz");
  }

  console.log("\n=== WALLET SETUP COMPLETED SUCCESSFULLY ===");
}

main().catch((err) => {
  console.error("Wallet setup error:", err);
  process.exit(1);
});

