import { request } from "node:https";
import { getEnv } from "../config/env.js";
import { ShroudError } from "../shared/errors.js";
import { PriceSource, ZecQuote } from "./types.js";

interface CacheEntry {
  quote: ZecQuote;
  cachedAt: number;
}

export class OneClickPriceSource implements PriceSource {
  readonly name = "oneclick" as const;
  private readonly baseUrl: string;
  private readonly slippageBps: number;
  private readonly zecAssetId: string;
  private readonly usdcAssetId: string;
  private readonly cache = new Map<number, CacheEntry>();
  private readonly cacheTtlMs = 60_000; // 60 seconds

  constructor() {
    const env = getEnv();
    this.baseUrl = env.ONECLICK_BASE_URL;
    this.slippageBps = env.SLIPPAGE_BPS;
    this.zecAssetId = env.ONECLICK_ZEC_ASSET_ID;
    this.usdcAssetId = env.ONECLICK_USDC_ASSET_ID;
  }

  async quoteUsdCentsToZats(cents: number): Promise<ZecQuote> {
    const cached = this.cache.get(cents);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.quote;
    }

    const url = new URL("/v0/quote", this.baseUrl);
    const deadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // USDC has 6 decimals: 1 cent = $0.01 = 10,000 units
    const usdcUnits = String(cents * 10_000);

    const body = {
      dry: true,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: this.slippageBps,
      originAsset: this.zecAssetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: this.usdcAssetId,
      amount: usdcUnits,
      refundTo: "jash.near",
      refundType: "INTENTS",
      recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      recipientType: "DESTINATION_CHAIN",
      deadline
    };

    const payload = JSON.stringify(body);

    const data = await new Promise<any>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: url.pathname,
          method: "POST",
          family: 4,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
            Accept: "application/json",
            "User-Agent": "Shroud/1.0"
          },
          timeout: 8000
        },
        (res) => {
          let buf = "";
          res.on("data", (chunk) => (buf += chunk));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              return reject(new Error(`1Click HTTP ${res.statusCode}: ${buf}`));
            }
            try {
              resolve(buf ? JSON.parse(buf) : {});
            } catch (err: any) {
              reject(err);
            }
          });
        }
      );

      req.on("timeout", () => req.destroy(new Error("1Click quote timeout")));
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    const amountIn = data.quote?.amountIn || data.amountIn;
    if (!amountIn) {
      throw new ShroudError("QUOTE_FAILED", "1Click quote missing amountIn");
    }

    const zats = BigInt(amountIn);
    const zecAmount = Number(zats) / 100_000_000;
    const usd = cents / 100;
    const usdPerZec = zecAmount > 0 ? Math.round((usd / zecAmount) * 100) / 100 : 35;

    const quote: ZecQuote = {
      zats,
      usdPerZec,
      source: "oneclick",
      expiresAt: deadline,
      raw: data
    };

    this.cache.set(cents, { quote, cachedAt: Date.now() });
    return quote;
  }
}

