import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/policy/engine.js";
import { Policy, PurchaseRequest, SpendState } from "../../src/policy/types.js";

const DEFAULT_POLICY: Policy = {
  paused: false,
  maxPerPurchaseCents: 2500, // $25.00
  dailyLimitCents: 5000, // $50.00
  monthlyLimitCents: 20000, // $200.00
  maxPurchasesPerDay: 5,
  requireApprovalAboveCents: 1000, // $10.00
  approveAllFirstTimeProducts: false,
  allowedTypes: ["giftcard", "esim", "refill"],
  allowedCountries: [],
  blockedProductIds: [],
  updatedAt: "2026-10-31T00:00:00.000Z"
};

const BASE_SPEND: SpendState = {
  spentLast24hCents: 0,
  spentLast30dCents: 0,
  purchasesLast24h: 0,
  previouslyBoughtProductIds: new Set(["test-card-1"]),
  vaultSpendableZats: 100_000_000n, // 1 ZEC
  requiredZats: 50_000n
};

const BASE_REQ: PurchaseRequest = {
  productId: "test-card-1",
  productType: "giftcard",
  country: "US",
  priceCents: 1000, // $10.00 (within $10 auto-approve limit)
  zats: 10_000n,
  source: "agent"
};

describe("Policy Engine (Pure Rules Evaluation)", () => {
  it("ALLOWs a valid request within all budget limits and approval thresholds", () => {
    const res = evaluate(BASE_REQ, DEFAULT_POLICY, BASE_SPEND);
    expect(res.decision).toBe("ALLOW");
    expect(res.reasons).toHaveLength(0);
    expect(res.remaining.dailyCents).toBe(5000);
    expect(res.remaining.monthlyCents).toBe(20000);
    expect(res.remaining.purchasesToday).toBe(5);
  });

  describe("R1: PAUSED", () => {
    it("DENYs all purchases when spending is paused", () => {
      const res = evaluate(BASE_REQ, { ...DEFAULT_POLICY, paused: true }, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("PAUSED");
      expect(res.reasons[0].message).toBe("Spending is paused by the owner.");
    });
  });

  describe("R2: INVALID_PRICE", () => {
    it("DENYs 0 price", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: 0 }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("INVALID_PRICE");
    });

    it("DENYs negative price", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: -500 }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("INVALID_PRICE");
    });

    it("DENYs non-integer price", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: 10.5 }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("INVALID_PRICE");
    });
  });

  describe("R3: BLOCKED_PRODUCT", () => {
    it("DENYs blacklisted products", () => {
      const policy: Policy = {
        ...DEFAULT_POLICY,
        blockedProductIds: ["blocked-sku", "test-card-1"]
      };
      const res = evaluate(BASE_REQ, policy, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("BLOCKED_PRODUCT");
      expect(res.reasons[0].message).toContain("blocked by your rules");
    });
  });

  describe("R4: TYPE_NOT_ALLOWED", () => {
    it("DENYs disallowed product types", () => {
      const res = evaluate({ ...BASE_REQ, productType: "bill" }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("TYPE_NOT_ALLOWED");
      expect(res.reasons[0].message).toContain("bill purchases are not allowed");
    });
  });

  describe("R5: COUNTRY_NOT_ALLOWED", () => {
    it("ALLOWs any country when allowedCountries is empty", () => {
      const res = evaluate({ ...BASE_REQ, country: "JP" }, { ...DEFAULT_POLICY, allowedCountries: [] }, BASE_SPEND);
      expect(res.decision).toBe("ALLOW");
    });

    it("ALLOWs country matching whitelist case-insensitively", () => {
      const policy: Policy = { ...DEFAULT_POLICY, allowedCountries: ["US", "IN"] };
      const res = evaluate({ ...BASE_REQ, country: "us" }, policy, BASE_SPEND);
      expect(res.decision).toBe("ALLOW");
    });

    it("ALLOWs null country (global products) even if whitelist specified", () => {
      const policy: Policy = { ...DEFAULT_POLICY, allowedCountries: ["US"] };
      const res = evaluate({ ...BASE_REQ, country: null }, policy, BASE_SPEND);
      expect(res.decision).toBe("ALLOW");
    });

    it("DENYs country not in whitelist", () => {
      const policy: Policy = { ...DEFAULT_POLICY, allowedCountries: ["US", "IN"] };
      const res = evaluate({ ...BASE_REQ, country: "GB" }, policy, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("COUNTRY_NOT_ALLOWED");
      expect(res.reasons[0].message).toBe("Products for GB are not allowed.");
    });
  });

  describe("R6: OVER_PER_PURCHASE (Boundary Semantics)", () => {
    it("ALLOWs price exactly equal to maxPerPurchaseCents", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: 2500 }, DEFAULT_POLICY, BASE_SPEND);
      // Notice: $25 is > $10 auto-approval threshold, so it ASKs, but does NOT DENY!
      expect(res.decision).toBe("ASK");
      expect(res.reasons.some((r) => r.rule === "OVER_PER_PURCHASE")).toBe(false);
    });

    it("DENYs price exceeding maxPerPurchaseCents by 1 cent", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: 2501 }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons.some((r) => r.rule === "OVER_PER_PURCHASE")).toBe(true);
      expect(res.reasons.find((r) => r.rule === "OVER_PER_PURCHASE")?.message).toBe(
        "$25.01 is over your $25.00 per-purchase limit."
      );
    });
  });

  describe("R7: OVER_DAILY (Rolling 24h Cap)", () => {
    it("ALLOWs spend when spent + price == dailyLimit", () => {
      const spend: SpendState = { ...BASE_SPEND, spentLast24hCents: 4000 };
      const res = evaluate({ ...BASE_REQ, priceCents: 1000 }, DEFAULT_POLICY, spend);
      expect(res.decision).toBe("ALLOW");
    });

    it("DENYs spend when spent + price > dailyLimit", () => {
      const spend: SpendState = { ...BASE_SPEND, spentLast24hCents: 4500 };
      const res = evaluate({ ...BASE_REQ, priceCents: 600 }, DEFAULT_POLICY, spend);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("OVER_DAILY");
      expect(res.reasons[0].message).toBe("This would exceed your daily limit ($5.00 left today).");
    });
  });

  describe("R8: OVER_MONTHLY (Rolling 30d Cap)", () => {
    it("ALLOWs spend when spent + price == monthlyLimit", () => {
      const spend: SpendState = { ...BASE_SPEND, spentLast30dCents: 19000 };
      const res = evaluate({ ...BASE_REQ, priceCents: 1000 }, DEFAULT_POLICY, spend);
      expect(res.decision).toBe("ALLOW");
    });

    it("DENYs spend when spent + price > monthlyLimit", () => {
      const spend: SpendState = { ...BASE_SPEND, spentLast30dCents: 19500 };
      const res = evaluate({ ...BASE_REQ, priceCents: 600 }, DEFAULT_POLICY, spend);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("OVER_MONTHLY");
      expect(res.reasons[0].message).toBe("This would exceed your monthly limit ($5.00 left).");
    });
  });

  describe("R9: TOO_MANY_TODAY (Transaction Count Cap)", () => {
    it("ALLOWs when purchasesLast24h + 1 == maxPurchasesPerDay", () => {
      const spend: SpendState = { ...BASE_SPEND, purchasesLast24h: 4 };
      const res = evaluate(BASE_REQ, DEFAULT_POLICY, spend);
      expect(res.decision).toBe("ALLOW");
    });

    it("DENYs when purchasesLast24h reaches maxPurchasesPerDay", () => {
      const spend: SpendState = { ...BASE_SPEND, purchasesLast24h: 5 };
      const res = evaluate(BASE_REQ, DEFAULT_POLICY, spend);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("TOO_MANY_TODAY");
      expect(res.reasons[0].message).toBe("You've hit 5 purchases today.");
    });
  });

  describe("R10: INSUFFICIENT_FUNDS", () => {
    it("DENYs when vault spendable balance is less than required zats", () => {
      const spend: SpendState = {
        ...BASE_SPEND,
        vaultSpendableZats: 10_000n,
        requiredZats: 60_000n
      };
      const res = evaluate(BASE_REQ, DEFAULT_POLICY, spend);
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("INSUFFICIENT_FUNDS");
      expect(res.reasons[0].message).toContain("Vault doesn't have enough spendable ZEC");
    });
  });

  describe("R11: NEEDS_APPROVAL_AMOUNT (Auto-approval Threshold)", () => {
    it("ALLOWs (auto-approves) when price exactly equals requireApprovalAboveCents", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: 1000 }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("ALLOW");
    });

    it("ASKs when price exceeds requireApprovalAboveCents by 1 cent", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: 1001 }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("ASK");
      expect(res.reasons[0].rule).toBe("NEEDS_APPROVAL_AMOUNT");
      expect(res.reasons[0].message).toBe("$10.01 is above your auto-approve limit of $10.00.");
    });
  });

  describe("R12: NEEDS_APPROVAL_NEW_PRODUCT", () => {
    it("ALLOWs repeat product even when approveAllFirstTimeProducts is enabled", () => {
      const policy: Policy = { ...DEFAULT_POLICY, approveAllFirstTimeProducts: true };
      const res = evaluate(BASE_REQ, policy, BASE_SPEND);
      expect(res.decision).toBe("ALLOW");
    });

    it("ASKs for first-time product when approveAllFirstTimeProducts is enabled", () => {
      const policy: Policy = { ...DEFAULT_POLICY, approveAllFirstTimeProducts: true };
      const res = evaluate({ ...BASE_REQ, productId: "brand-new-card" }, policy, BASE_SPEND);
      expect(res.decision).toBe("ASK");
      expect(res.reasons[0].rule).toBe("NEEDS_APPROVAL_NEW_PRODUCT");
      expect(res.reasons[0].message).toBe("First time buying this product.");
    });
  });

  describe("Multi-Rule Precedence & Decision Hierarchy", () => {
    it("Prioritizes DENY when both DENY and ASK conditions trigger", () => {
      // price $30 > $25 cap (DENY) and > $10 threshold (ASK)
      const res = evaluate({ ...BASE_REQ, priceCents: 3000 }, DEFAULT_POLICY, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons.some((r) => r.rule === "OVER_PER_PURCHASE" && r.outcome === "DENY")).toBe(true);
      expect(res.reasons.some((r) => r.rule === "NEEDS_APPROVAL_AMOUNT" && r.outcome === "ASK")).toBe(true);
    });

    it("Collects all violated DENY rules in strict order", () => {
      const policy: Policy = {
        ...DEFAULT_POLICY,
        paused: true,
        blockedProductIds: ["test-card-1"]
      };
      const res = evaluate(BASE_REQ, policy, BASE_SPEND);
      expect(res.decision).toBe("DENY");
      expect(res.reasons.map((r) => r.rule)).toEqual(["PAUSED", "BLOCKED_PRODUCT"]);
    });
  });

  describe("Re-evaluation at Approval Time (ignoreAskRules)", () => {
    it("ALLOWs request with price > threshold when ignoreAskRules is true", () => {
      const res = evaluate({ ...BASE_REQ, priceCents: 1500 }, DEFAULT_POLICY, BASE_SPEND, {
        ignoreAskRules: true
      });
      expect(res.decision).toBe("ALLOW");
      expect(res.reasons).toHaveLength(0);
    });

    it("Still DENYs if paused or budget cap exceeded even with ignoreAskRules true", () => {
      const res = evaluate(
        { ...BASE_REQ, priceCents: 1500 },
        { ...DEFAULT_POLICY, paused: true },
        BASE_SPEND,
        { ignoreAskRules: true }
      );
      expect(res.decision).toBe("DENY");
      expect(res.reasons[0].rule).toBe("PAUSED");
    });
  });
});

