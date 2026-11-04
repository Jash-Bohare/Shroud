import { config } from "dotenv";
import { z } from "zod";

// Load environment variables from .env file
config();

const fxSchema = z.string().transform((val, ctx) => {
  try {
    const parsed = JSON.parse(val);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error();
    }
    return parsed as Record<string, number>;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "FX_USD_PER must be a valid JSON object string (e.g. {\"INR\":0.012})"
    });
    return z.NEVER;
  }
});

export const rawEnvSchema = z.object({
  // Mode
  SHROUD_MODE: z.enum(["demo", "live"]).default("demo"),
  ZCASH_NETWORK: z.enum(["test", "main"]).default("test"),

  // Zcash
  ZDT_BIN: z.string().default("/home/jash/zcash-devtool/target/release/zcash-devtool"),
  ZDT_WALLET_DIR: z.string().default("/home/jash/shroud-data/wallet"),
  ZDT_IDENTITY_FILE: z.string().default("/home/jash/shroud-data/identity.txt"),
  ZDT_SERVER: z.string().optional().default(""),
  VAULT_ACCOUNT_UUID: z.string().optional().default(""),
  RECEIPTS_ACCOUNT_UUID: z.string().optional().default(""),
  DESK_ACCOUNT_UUID: z.string().optional().default(""),
  RECEIPT_OUTPUT_ZATS: z.coerce.bigint().default(0n),
  MAX_SINGLE_PAYMENT_ZATS: z.coerce.bigint().default(50_000_000n),
  DEMO_AMOUNT_SCALE: z.coerce.number().positive().max(1).default(1),
  MIN_DEMO_ZATS: z.coerce.bigint().default(10000n),
  DEMO_DESK_MIN_CONF: z.coerce.number().default(1),
  // How the desk fulfils demo orders: "test" = Bitrefill test product (free),
  // "balance" = the real product, paid from the account's Bitrefill store credit.
  BITREFILL_ORDER_MODE: z.enum(["test", "balance"]).default("test"),
  BITREFILL_BALANCE_MAX_ORDER_CENTS: z.coerce.number().int().positive().default(1000),
  BITREFILL_BALANCE_MAX_TOTAL_CENTS: z.coerce.number().int().positive().default(2500),

  // Pricing / 1Click
  PRICE_SOURCE: z.enum(["oneclick", "coingecko", "fixed"]).default("oneclick"),
  ONECLICK_BASE_URL: z.string().default("https://1click.chaindefuser.com"),
  ONECLICK_JWT: z.string().optional().default(""),
  ONECLICK_ZEC_ASSET_ID: z.string().optional().default(""),
  ONECLICK_USDC_ASSET_ID: z.string().optional().default(""),
  SLIPPAGE_BPS: z.coerce.number().default(100),
  QUOTE_DEADLINE_MIN: z.coerce.number().default(15),
  DRY_QUOTE_REFUND_ZEC_ADDRESS: z.string().default("t1bH16973jRzFh4Fj3qjZqA4Zf5q2b4B8Q1"),
  DRY_QUOTE_RECIPIENT: z.string().default("0x000000000000000000000000000000000000dEaD"),
  FIXED_USD_PER_ZEC: z.coerce.number().default(35),
  SHROUD_FEE_BPS: z.coerce.number().default(0),
  SHROUD_FEE_RECIPIENT: z.string().optional().default(""),

  // Bitrefill
  BITREFILL_MODE: z.enum(["api", "mock"]).default("api"),
  BITREFILL_API_KEY: z.string().optional().default(""),
  BITREFILL_PAYMENT_METHOD: z.string().default("usdc_base"),
  BITREFILL_REFUND_ADDRESS: z.string().optional().default(""),
  FX_USD_PER: fxSchema.default("{\"INR\":0.012,\"EUR\":1.08,\"USD\":1}"),

  // LLM
  LLM_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().default("openai/gpt-oss-120b"),
  LLM_FALLBACK_BASE_URL: z.string().optional().default(""),
  LLM_FALLBACK_API_KEY: z.string().optional().default(""),
  LLM_FALLBACK_MODEL: z.string().optional().default(""),
  LLM_MAX_STEPS: z.coerce.number().default(10),
  AGENT_HISTORY_TURNS: z.coerce.number().default(10),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_OWNER_ID: z.coerce.number().default(0),
  DELIVER_CODES_TO: z.enum(["telegram", "dashboard"]).default("telegram"),

  // App
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().default(8787),
  DASHBOARD_TOKEN: z.string().min(1, "DASHBOARD_TOKEN is required"),
  DASHBOARD_ORIGIN: z.string().default("http://localhost:5173"),
  DB_PATH: z.string().default("./data/shroud.db"),
  CODE_ENCRYPTION_KEY: z.string().min(1, "CODE_ENCRYPTION_KEY is required"),
  WORKER_TICK_MS: z.coerce.number().default(5000),
  APPROVAL_TTL_MIN: z.coerce.number().default(10),
  SWAP_TIMEOUT_MIN: z.coerce.number().default(15),
  MAX_STEP_RETRIES: z.coerce.number().default(5),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")
});

export const envSchema = rawEnvSchema.superRefine((data, ctx) => {
  if (data.SHROUD_MODE === "demo" && data.ZCASH_NETWORK !== "test") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "SHROUD_MODE=demo requires ZCASH_NETWORK=test",
      path: ["ZCASH_NETWORK"]
    });
  }

  if (data.SHROUD_MODE === "live") {
    if (data.ZCASH_NETWORK !== "main") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SHROUD_MODE=live requires ZCASH_NETWORK=main",
        path: ["ZCASH_NETWORK"]
      });
    }
    if (data.BITREFILL_MODE !== "api") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SHROUD_MODE=live requires BITREFILL_MODE=api",
        path: ["BITREFILL_MODE"]
      });
    }
    if (!data.BITREFILL_REFUND_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SHROUD_MODE=live requires BITREFILL_REFUND_ADDRESS",
        path: ["BITREFILL_REFUND_ADDRESS"]
      });
    }
    if (!data.ONECLICK_ZEC_ASSET_ID || !data.ONECLICK_USDC_ASSET_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SHROUD_MODE=live requires ONECLICK_ZEC_ASSET_ID and ONECLICK_USDC_ASSET_ID",
        path: ["ONECLICK_ZEC_ASSET_ID"]
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!cachedEnv) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`[CONFIG ERROR] Invalid environment configuration:\n${issues}`);
    }
    cachedEnv = result.data;
  }
  return cachedEnv;
}

