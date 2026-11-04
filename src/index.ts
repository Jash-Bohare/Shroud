import { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { AgentSession } from "./agent/loop.js";
import { OpenAiLlmClient } from "./agent/llm.js";
import { createApiApp } from "./api/server.js";
import { getEnv } from "./config/env.js";
import { createDatabase, runMigrations } from "./db/db.js";
import { BitrefillMerchantAdapter } from "./merchant/bitrefill.js";
import { MockMerchantAdapter } from "./merchant/mock.js";
import { MerchantAdapter } from "./merchant/types.js";
import { PolicyStore } from "./policy/store.js";
import { PricingService } from "./pricing/service.js";
import { DemoSwapExecutor } from "./router/demo-swap.js";
import { LiveSwapExecutor } from "./router/live-swap.js";
import { PurchaseService } from "./router/purchase-service.js";
import { SwapExecutor } from "./router/types.js";
import { PurchaseWorker } from "./router/worker.js";
import { logger } from "./shared/logger.js";
import { createTelegramBot, setupTelegramNotifier } from "./telegram/bot.js";
import { VaultConfig, VaultService } from "./zcash/vault.js";

export interface ShroudApp {
  env: ReturnType<typeof getEnv>;
  db: ReturnType<typeof createDatabase>;
  vault: VaultService;
  merchant: MerchantAdapter;
  pricing: PricingService;
  executor: SwapExecutor;
  purchaseService: PurchaseService;
  policyStore: PolicyStore;
  worker: PurchaseWorker;
  agentSession?: AgentSession;
  bot?: ReturnType<typeof createTelegramBot>;
  server: Server;
  stop: () => Promise<void>;
}

export async function boot(): Promise<ShroudApp> {
  logger.info("Initializing Shroud...");

  // 1. Validate environment
  const env = getEnv();
  logger.info({ mode: env.SHROUD_MODE, network: env.ZCASH_NETWORK }, "Configuration loaded");

  // 2. Initialize Database & run migrations
  const db = createDatabase(env.DB_PATH);
  runMigrations(db);

  // 3. Initialize Policy Store
  const policyStore = new PolicyStore(db);

  // 4. Initialize Vault Service
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

  // 5. Merchant Adapter
  let merchant: MerchantAdapter;
  if (env.BITREFILL_MODE === "mock" || !env.BITREFILL_API_KEY) {
    logger.info("Using MockMerchantAdapter for products & quotes");
    merchant = new MockMerchantAdapter();
  } else {
    logger.info("Using live BitrefillMerchantAdapter (API)");
    merchant = new BitrefillMerchantAdapter();
  }

  // 6. Pricing Service
  const pricing = new PricingService();

  // 7. Swap Executor
  let executor: SwapExecutor;
  if (env.SHROUD_MODE === "demo") {
    executor = new DemoSwapExecutor({
      vault,
      merchant,
      amountScale: env.DEMO_AMOUNT_SCALE,
      minDemoZats: env.MIN_DEMO_ZATS,
      minConf: env.DEMO_DESK_MIN_CONF,
      orderMode: env.BITREFILL_ORDER_MODE,
      maxOrderCents: env.BITREFILL_BALANCE_MAX_ORDER_CENTS,
      maxTotalCents: env.BITREFILL_BALANCE_MAX_TOTAL_CENTS,
      db
    });
    logger.info(
      { orderMode: env.BITREFILL_ORDER_MODE, amountScale: env.DEMO_AMOUNT_SCALE },
      env.BITREFILL_ORDER_MODE === "balance"
        ? "Desk fulfils REAL Bitrefill products from store credit (capped)"
        : "Desk fulfils with the Bitrefill test product"
    );
  } else {
    executor = new LiveSwapExecutor({
      vault,
      merchant
    });
  }

  // 8. Purchase Service
  const purchaseService = new PurchaseService({
    db,
    merchant,
    pricing,
    executor,
    vault,
    policyStore,
    mode: env.SHROUD_MODE
  });

  // 9. Background Worker
  const worker = new PurchaseWorker({
    db,
    vault,
    merchant,
    executor,
    policyStore,
    tickIntervalMs: env.WORKER_TICK_MS
  });
  worker.start();

  // 10. Agent & LLM
  let agentSession: AgentSession | undefined;
  if (env.LLM_API_KEY) {
    const llm = new OpenAiLlmClient({
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      fallbackApiKey: env.LLM_FALLBACK_API_KEY,
      fallbackBaseUrl: env.LLM_FALLBACK_BASE_URL,
      fallbackModel: env.LLM_FALLBACK_MODEL
    });
    agentSession = new AgentSession({
      llm,
      merchant,
      purchaseService,
      maxSteps: env.LLM_MAX_STEPS,
      historyTurns: env.AGENT_HISTORY_TURNS
    });
    logger.info({ model: env.LLM_MODEL }, "Agent session initialized");
  } else {
    logger.warn("No LLM_API_KEY configured; agent chat sessions disabled");
  }

  // 11. Telegram Bot
  let bot: ReturnType<typeof createTelegramBot> | undefined;
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_ID && agentSession) {
    bot = createTelegramBot({
      vault,
      purchaseService,
      policyStore,
      agentSession,
      botToken: env.TELEGRAM_BOT_TOKEN,
      ownerId: env.TELEGRAM_OWNER_ID,
      deskBudget:
        executor instanceof DemoSwapExecutor ? () => (executor as DemoSwapExecutor).realOrderBudget() : undefined
    });
    setupTelegramNotifier(bot, purchaseService, env.TELEGRAM_OWNER_ID);
    bot.start({
      onStart: (info) => {
        logger.info({ username: info.username }, "Telegram bot polling started");
      }
    });
  } else {
    logger.info("Telegram bot not configured (requires TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID)");
  }

  // 12. REST API & SSE Server
  const app = createApiApp({
    db,
    vault,
    purchaseService,
    policyStore,
    merchant,
    pricing,
    dashboardToken: env.DASHBOARD_TOKEN,
    deskBudget:
      executor instanceof DemoSwapExecutor ? () => (executor as DemoSwapExecutor).realOrderBudget() : undefined
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(env.API_PORT, env.API_HOST, () => {
      logger.info(
        { host: env.API_HOST, port: env.API_PORT },
        `Shroud REST API ready at http://${env.API_HOST}:${env.API_PORT}`
      );
      resolve(s);
    });
  });

  const stop = async () => {
    logger.info("Shutting down Shroud...");
    worker.stop();
    if (bot) {
      bot.stop();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    logger.info("Shroud shutdown complete");
  };

  return {
    env,
    db,
    vault,
    merchant,
    pricing,
    executor,
    purchaseService,
    policyStore,
    worker,
    agentSession,
    bot,
    server,
    stop
  };
}

// Auto-run if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  boot().then((app) => {
    const handleSignal = async (sig: string) => {
      logger.info({ sig }, "Received termination signal");
      await app.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
  }).catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "Fatal error during Shroud boot");
    process.exit(1);
  });
}
