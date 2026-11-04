import { centsToUsd } from "../shared/money.js";
import {
  Decision,
  Evaluation,
  Policy,
  PurchaseRequest,
  RuleResult,
  SpendState
} from "./types.js";

export interface EvaluateOptions {
  /**
   * If true, skips R11 (amount above threshold) and R12 (first time product),
   * but still evaluates all hard DENY rules (R1 to R10).
   * Used when the human owner has explicitly approved the purchase.
   */
  ignoreAskRules?: boolean;
}

/**
 * Pure, deterministic policy engine evaluating purchase requests against configured policy and spend state.
 * Evaluates rules R1 through R12 in order without any side effects or I/O.
 */
export function evaluate(
  req: PurchaseRequest,
  policy: Policy,
  spend: SpendState,
  opts?: EvaluateOptions
): Evaluation {
  const results: RuleResult[] = [];

  // R1: PAUSED
  if (policy.paused) {
    results.push({
      rule: "PAUSED",
      outcome: "DENY",
      message: "Spending is paused by the owner."
    });
  }

  // R2: INVALID_PRICE
  if (!Number.isInteger(req.priceCents) || req.priceCents <= 0) {
    results.push({
      rule: "INVALID_PRICE",
      outcome: "DENY",
      message: "Invalid price."
    });
  }

  // R3: BLOCKED_PRODUCT
  if (policy.blockedProductIds.includes(req.productId)) {
    results.push({
      rule: "BLOCKED_PRODUCT",
      outcome: "DENY",
      message: "This product is blocked by your rules."
    });
  }

  // R4: TYPE_NOT_ALLOWED
  if (!policy.allowedTypes.includes(req.productType)) {
    results.push({
      rule: "TYPE_NOT_ALLOWED",
      outcome: "DENY",
      message: `${req.productType} purchases are not allowed.`
    });
  }

  // R5: COUNTRY_NOT_ALLOWED
  if (
    policy.allowedCountries.length > 0 &&
    req.country !== null &&
    !policy.allowedCountries.map((c) => c.toUpperCase()).includes(req.country.toUpperCase())
  ) {
    results.push({
      rule: "COUNTRY_NOT_ALLOWED",
      outcome: "DENY",
      message: `Products for ${req.country} are not allowed.`
    });
  }

  // R6: OVER_PER_PURCHASE
  if (req.priceCents > policy.maxPerPurchaseCents) {
    results.push({
      rule: "OVER_PER_PURCHASE",
      outcome: "DENY",
      message: `${centsToUsd(req.priceCents)} is over your ${centsToUsd(policy.maxPerPurchaseCents)} per-purchase limit.`
    });
  }

  // R7: OVER_DAILY
  if (spend.spentLast24hCents + req.priceCents > policy.dailyLimitCents) {
    const left = Math.max(0, policy.dailyLimitCents - spend.spentLast24hCents);
    results.push({
      rule: "OVER_DAILY",
      outcome: "DENY",
      message: `This would exceed your daily limit (${centsToUsd(left)} left today).`
    });
  }

  // R8: OVER_MONTHLY
  if (spend.spentLast30dCents + req.priceCents > policy.monthlyLimitCents) {
    const left = Math.max(0, policy.monthlyLimitCents - spend.spentLast30dCents);
    results.push({
      rule: "OVER_MONTHLY",
      outcome: "DENY",
      message: `This would exceed your monthly limit (${centsToUsd(left)} left).`
    });
  }

  // R9: TOO_MANY_TODAY
  if (spend.purchasesLast24h + 1 > policy.maxPurchasesPerDay) {
    results.push({
      rule: "TOO_MANY_TODAY",
      outcome: "DENY",
      message: `You've hit ${policy.maxPurchasesPerDay} purchases today.`
    });
  }

  // R10: INSUFFICIENT_FUNDS
  if (spend.vaultSpendableZats < spend.requiredZats) {
    results.push({
      rule: "INSUFFICIENT_FUNDS",
      outcome: "DENY",
      message: "Vault doesn't have enough spendable ZEC. Top up with /fund."
    });
  }

  // R11: NEEDS_APPROVAL_AMOUNT (Skipped if ignoreAskRules is true)
  if (!opts?.ignoreAskRules && req.priceCents > policy.requireApprovalAboveCents) {
    results.push({
      rule: "NEEDS_APPROVAL_AMOUNT",
      outcome: "ASK",
      message: `${centsToUsd(req.priceCents)} is above your auto-approve limit of ${centsToUsd(policy.requireApprovalAboveCents)}.`
    });
  }

  // R12: NEEDS_APPROVAL_NEW_PRODUCT (Skipped if ignoreAskRules is true)
  if (
    !opts?.ignoreAskRules &&
    policy.approveAllFirstTimeProducts &&
    !spend.previouslyBoughtProductIds.has(req.productId)
  ) {
    results.push({
      rule: "NEEDS_APPROVAL_NEW_PRODUCT",
      outcome: "ASK",
      message: "First time buying this product."
    });
  }

  // Resolve overall decision
  let decision: Decision = "ALLOW";
  if (results.some((r) => r.outcome === "DENY")) {
    decision = "DENY";
  } else if (results.some((r) => r.outcome === "ASK")) {
    decision = "ASK";
  }

  return {
    decision,
    reasons: results,
    remaining: {
      dailyCents: Math.max(0, policy.dailyLimitCents - spend.spentLast24hCents),
      monthlyCents: Math.max(0, policy.monthlyLimitCents - spend.spentLast30dCents),
      purchasesToday: Math.max(0, policy.maxPurchasesPerDay - spend.purchasesLast24h)
    }
  };
}

