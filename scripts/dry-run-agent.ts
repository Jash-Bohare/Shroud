/**
 * Dry run of the agent against the real LLM + Bitrefill catalog + pricing.
 * The vault is faked and request_purchase is intercepted: nothing is bought or paid.
 * Usage: npx tsx scripts/dry-run-agent.ts "I need an India eSIM, 10GB for 30 days"
 */
import Database from "better-sqlite3";
import { OpenAiLlmClient, ChatMessage, ToolDef, ChatOptions } from "../src/agent/llm.js";
import { AgentSession } from "../src/agent/loop.js";
import { getEnv } from "../src/config/env.js";
import { runMigrations } from "../src/db/db.js";
import { BitrefillMerchantAdapter } from "../src/merchant/bitrefill.js";
import { PolicyStore } from "../src/policy/store.js";
import { PricingService } from "../src/pricing/service.js";
import { DemoSwapExecutor } from "../src/router/demo-swap.js";
import { PurchaseService } from "../src/router/purchase-service.js";
import { VaultService } from "../src/zcash/vault.js";

async function main() {
  const env = getEnv();
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  runMigrations(db);
  const merchant = new BitrefillMerchantAdapter();
  const vault = {
    getDeskAddress: async () => "utest1deskaddressdryrun",
    getBalance: async () => ({
      totalZats: 99_000_000n, spendableZats: 99_000_000n, pendingZats: 0n, transparentZats: 0n,
      ironwoodSpendable: 99_000_000n, orchardSpendable: 0n, saplingSpendable: 0n, chainTipHeight: 1
    })
  } as unknown as VaultService;
  const policyStore = new PolicyStore(db);
  const executor = new DemoSwapExecutor({ vault, merchant, amountScale: 0.01, minDemoZats: 10_000n });
  const purchaseService = new PurchaseService({ db, merchant, pricing: new PricingService(), executor, vault, policyStore, mode: "demo" });

  const real = new OpenAiLlmClient({ apiKey: env.LLM_API_KEY!, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL });
  const llm = {
    chat: async (m: ChatMessage[], t: ToolDef[], o?: ChatOptions) => {
      const turn = await real.chat(m, t, o);
      for (const tc of turn.toolCalls) console.log(`  tool → ${tc.function.name} ${tc.function.arguments}`);
      if (turn.content && !turn.toolCalls.length) console.log(`  text → ${turn.content}`);
      return turn;
    }
  };
  const session = new AgentSession({ llm, merchant, purchaseService });

  for (const msg of process.argv.slice(2)) {
    console.log(`\nUSER: ${msg}`);
    const res = await session.run(msg);
    for (const id of res.purchaseIds) {
      const p = purchaseService.get(id);
      console.log(`  [purchase recorded in in-memory DB only] ${p.productName} ${p.faceValue} ${p.priceUsd} → ${p.status}`);
    }
    console.log(`BOT: ${res.reply}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
