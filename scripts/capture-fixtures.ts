import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "../src/config/env.js";
import { runDevtool } from "../src/zcash/devtool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const env = getEnv();
  const outDir = join(__dirname, "../tests/fixtures/devtool");
  mkdirSync(outDir, { recursive: true });

  const vaultUuid = env.VAULT_ACCOUNT_UUID!;

  console.log("Capturing devtool fixtures...");

  // 1. balance --json
  const balance = await runDevtool(["balance", vaultUuid, "--json"]);
  writeFileSync(join(outDir, "balance.json"), balance.stdout);

  // 2. list-accounts
  const accounts = await runDevtool(["list-accounts"]);
  writeFileSync(join(outDir, "list-accounts.txt"), accounts.stdout);

  // 3. list-addresses
  const addresses = await runDevtool(["list-addresses", vaultUuid]);
  writeFileSync(join(outDir, "list-addresses.txt"), addresses.stdout);

  // 4. list-tx --json
  const listTxJson = await runDevtool(["list-tx", "--json"]);
  writeFileSync(join(outDir, "list-tx.json"), listTxJson.stdout);

  // 5. list-tx --mode csv
  const listTxCsv = await runDevtool(["list-tx", "--mode", "csv"]);
  writeFileSync(join(outDir, "list-tx.csv"), listTxCsv.stdout);

  // 6. list-tx text
  const listTxText = await runDevtool(["list-tx"]);
  writeFileSync(join(outDir, "list-tx.txt"), listTxText.stdout);

  console.log("Fixtures saved successfully to tests/fixtures/devtool/");
}

main().catch(console.error);

