export type ProductType = "giftcard" | "esim" | "refill" | "bill" | "other";

export interface Policy {
  paused: boolean;
  maxPerPurchaseCents: number; // hard cap per purchase
  dailyLimitCents: number; // rolling 24h
  monthlyLimitCents: number; // rolling 30d
  maxPurchasesPerDay: number; // rolling 24h count
  requireApprovalAboveCents: number; // > this -> ASK
  approveAllFirstTimeProducts: boolean; // product never bought before -> ASK
  allowedTypes: ProductType[]; // empty = none allowed
  allowedCountries: string[]; // ISO-2 upper-case; empty = any
  blockedProductIds: string[];
  updatedAt: string; // ISO
}

export interface PurchaseRequest {
  productId: string;
  productType: ProductType;
  country: string | null; // ISO-2 or null for global products
  priceCents: number; // USD cents, integer > 0
  zats: bigint; // informational (not used for caps)
  source: "agent" | "telegram" | "dashboard";
}

export interface SpendState {
  spentLast24hCents: number; // sum of counted purchases
  spentLast30dCents: number;
  purchasesLast24h: number;
  previouslyBoughtProductIds: Set<string>;
  vaultSpendableZats: bigint;
  requiredZats: bigint; // zats this purchase needs incl. fees
}

export type Decision = "ALLOW" | "ASK" | "DENY";

export type RuleId =
  | "PAUSED"
  | "INVALID_PRICE"
  | "BLOCKED_PRODUCT"
  | "TYPE_NOT_ALLOWED"
  | "COUNTRY_NOT_ALLOWED"
  | "OVER_PER_PURCHASE"
  | "OVER_DAILY"
  | "OVER_MONTHLY"
  | "TOO_MANY_TODAY"
  | "INSUFFICIENT_FUNDS"
  | "NEEDS_APPROVAL_AMOUNT"
  | "NEEDS_APPROVAL_NEW_PRODUCT"
  // Settlement limit from the desk (store-credit caps for real orders), added by quote()
  | "REAL_ORDER_CAP";

export interface RuleResult {
  rule: RuleId;
  outcome: Decision;
  message: string;
}

export interface Evaluation {
  decision: Decision;
  reasons: RuleResult[]; // only the non-ALLOW results, ordered
  remaining: {
    dailyCents: number;
    monthlyCents: number;
    purchasesToday: number;
  };
}

