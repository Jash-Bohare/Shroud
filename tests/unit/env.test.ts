import { describe, it, expect } from "vitest";
import { envSchema } from "../../src/config/env.js";

describe("environment configuration schema", () => {
  const baseValid = {
    SHROUD_MODE: "demo",
    ZCASH_NETWORK: "test",
    DASHBOARD_TOKEN: "valid-dashboard-token-12345",
    CODE_ENCRYPTION_KEY: "dGVzdC1vbmx5LWtleS1ub3QtYS1yZWFsLXNlY3JldCE=",
    FX_USD_PER: "{\"INR\":0.012,\"USD\":1}"
  };

  it("accepts valid demo configuration", () => {
    const res = envSchema.safeParse(baseValid);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.SHROUD_MODE).toBe("demo");
      expect(res.data.ZCASH_NETWORK).toBe("test");
      expect(res.data.RECEIPT_OUTPUT_ZATS).toBe(0n);
      expect(res.data.FX_USD_PER).toEqual({ INR: 0.012, USD: 1 });
    }
  });

  it("rejects demo mode with mainnet network", () => {
    const res = envSchema.safeParse({
      ...baseValid,
      SHROUD_MODE: "demo",
      ZCASH_NETWORK: "main"
    });
    expect(res.success).toBe(false);
  });

  it("rejects live mode if missing required fields", () => {
    const res = envSchema.safeParse({
      ...baseValid,
      SHROUD_MODE: "live",
      ZCASH_NETWORK: "main"
      // Missing BITREFILL_REFUND_ADDRESS, asset IDs, etc.
    });
    expect(res.success).toBe(false);
  });
});

