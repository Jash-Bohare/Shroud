export interface ZecQuote {
  zats: bigint;
  usdPerZec: number;
  source: "oneclick" | "coingecko" | "fixed";
  expiresAt: string;
  raw?: unknown;
}

export interface PriceSource {
  readonly name: "oneclick" | "coingecko" | "fixed";
  quoteUsdCentsToZats(cents: number): Promise<ZecQuote>;
}

