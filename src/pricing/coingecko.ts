import { request } from "node:https";
import { getEnv } from "../config/env.js";
import { ShroudError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { PriceSource, ZecQuote } from "./types.js";

interface CacheEntry {
  usdPerZec: number;
  cachedAt: number;
}

export class CoinGeckoPriceSource implements PriceSource {
  readonly name = "coingecko" as const;
  private readonly slippageBps: number;
  private cache: CacheEntry | null = null;
  private readonly cacheTtlMs = 60_000; // 60 seconds

  constructor(slippageBps?: number) {
    const env = getEnv();
    this.slippageBps = slippageBps ?? env.SLIPPAGE_BPS;
  }

  private async fetchUsdPrice(): Promise<number> {
    if (this.cache && Date.now() - this.cache.cachedAt < this.cacheTtlMs) {
      return this.cache.usdPerZec;
    }

    return new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: "api.coingecko.com",
          port: 443,
          path: "/api/v3/simple/price?ids=zcash&vs_currencies=usd",
          method: "GET",
          family: 4,
          headers: {
            Accept: "application/json",
            "User-Agent": "Shroud/1.0"
          },
          timeout: 5000
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`CoinGecko HTTP ${res.statusCode}`));
            }
            try {
              const parsed = JSON.parse(data);
              const usd = parsed?.zcash?.usd;
              if (typeof usd !== "number" || usd <= 0) {
                return reject(new Error("Invalid price in CoinGecko response"));
              }
              this.cache = { usdPerZec: usd, cachedAt: Date.now() };
              resolve(usd);
            } catch (err: any) {
              reject(err);
            }
          });
        }
      );

      req.on("timeout", () => req.destroy(new Error("CoinGecko timeout")));
      req.on("error", reject);
      req.end();
    });
  }

  async quoteUsdCentsToZats(cents: number): Promise<ZecQuote> {
    try {
      const usdPerZec = await this.fetchUsdPrice();
      const usd = cents / 100;
      const baseZats = (usd / usdPerZec) * 100_000_000;
      const slippageMult = 1 + this.slippageBps / 10_000;
      const zats = BigInt(Math.ceil(baseZats * slippageMult));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      return {
        zats,
        usdPerZec,
        source: "coingecko",
        expiresAt
      };
    } catch (err: any) {
      logger.warn({ err: err.message }, "CoinGecko price fetch failed");
      throw new ShroudError("PRICE_UNAVAILABLE", `CoinGecko price failed: ${err.message}`);
    }
  }
}

