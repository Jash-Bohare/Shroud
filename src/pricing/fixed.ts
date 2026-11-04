import { getEnv } from "../config/env.js";
import { PriceSource, ZecQuote } from "./types.js";

export class FixedPriceSource implements PriceSource {
  readonly name = "fixed" as const;
  private readonly usdPerZec: number;

  constructor(usdPerZec?: number) {
    const env = getEnv();
    this.usdPerZec = usdPerZec ?? env.FIXED_USD_PER_ZEC;
  }

  async quoteUsdCentsToZats(cents: number): Promise<ZecQuote> {
    const usd = cents / 100;
    // (usd / usdPerZec) * 1e8 zats
    const zats = BigInt(Math.ceil((usd / this.usdPerZec) * 100_000_000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    return {
      zats,
      usdPerZec: this.usdPerZec,
      source: "fixed",
      expiresAt
    };
  }
}

