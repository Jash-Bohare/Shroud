import { getEnv } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { CoinGeckoPriceSource } from "./coingecko.js";
import { FixedPriceSource } from "./fixed.js";
import { OneClickPriceSource } from "./oneclick.js";
import { PriceSource, ZecQuote } from "./types.js";

export class PricingService implements PriceSource {
  readonly name = "oneclick" as const;
  private readonly sources: PriceSource[];

  constructor(preferredSource?: "oneclick" | "coingecko" | "fixed") {
    const env = getEnv();
    const sourceName = preferredSource ?? env.PRICE_SOURCE;

    const oneclick = new OneClickPriceSource();
    const coingecko = new CoinGeckoPriceSource();
    const fixed = new FixedPriceSource();

    if (sourceName === "fixed") {
      this.sources = [fixed];
    } else if (sourceName === "coingecko") {
      this.sources = [coingecko, fixed];
    } else {
      // Default: oneclick -> coingecko -> fixed
      this.sources = [oneclick, coingecko, fixed];
    }
  }

  async quoteUsdCentsToZats(cents: number): Promise<ZecQuote> {
    let lastError: Error | null = null;

    for (const source of this.sources) {
      try {
        const quote = await source.quoteUsdCentsToZats(cents);
        return quote;
      } catch (err: any) {
        lastError = err;
        logger.warn(
          { source: source.name, err: err.message, cents },
          "Price source failed, falling back to next source"
        );
      }
    }

    throw lastError || new Error("All pricing sources failed");
  }
}

let pricingInstance: PricingService | null = null;

export function getPricingService(): PricingService {
  if (!pricingInstance) {
    pricingInstance = new PricingService();
  }
  return pricingInstance;
}

export * from "./types.js";
export * from "./fixed.js";
export * from "./coingecko.js";
export * from "./oneclick.js";

