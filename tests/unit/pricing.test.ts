import { describe, expect, it } from "vitest";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { PricingService } from "../../src/pricing/service.js";

describe("Pricing Modules", () => {
  it("calculates exact zats using FixedPriceSource", async () => {
    const fixed = new FixedPriceSource(35); // $35 / ZEC
    const quote = await fixed.quoteUsdCentsToZats(100); // $1.00 USD
    expect(quote.source).toBe("fixed");
    expect(quote.usdPerZec).toBe(35);
    // $1.00 / $35 = 0.028571428... ZEC = 2857143 zats
    expect(quote.zats).toBe(2857143n);
  });

  it("handles larger amounts accurately", async () => {
    const fixed = new FixedPriceSource(40); // $40 / ZEC
    const quote = await fixed.quoteUsdCentsToZats(2000); // $20.00 USD
    expect(quote.zats).toBe(50_000_000n); // exactly 0.5 ZEC
  });

  it("PricingService falls back gracefully to fixed when configured", async () => {
    const service = new PricingService("fixed");
    const quote = await service.quoteUsdCentsToZats(500);
    expect(quote.source).toBe("fixed");
    expect(quote.zats).toBeGreaterThan(0n);
  });
});

