export type Mode = "demo" | "live";
export type Status =
  | "CREATED"
  | "QUOTED"
  | "DENIED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "PAYING"
  | "PAID"
  | "SWAPPING"
  | "SWAPPED"
  | "REFUNDED"
  | "ORDERING"
  | "DELIVERED"
  | "FAILED";

export type ProductType = "giftcard" | "esim" | "refill" | "bill" | "other";
export type Source = "agent" | "telegram" | "dashboard";
export type Actor = "owner:telegram" | "owner:dashboard" | "system" | "agent";

export interface PurchaseView {
  id: string;
  status: Status;
  mode: Mode;
  productId: string;
  productName: string;
  productType: ProductType;
  country: string | null;
  faceValue: string;
  faceCurrency: string;
  priceCents: number;
  priceUsd: string;
  quotedZats: string;
  paidZats: string | null;
  zec: string;
  priceSource: "oneclick" | "coingecko" | "fixed";
  reason: string;
  source: Source;
  policyReasons: string[];
  policyDecision?: string | null;
  approvalNonce?: string | null;
  approvalExpiresAt?: string | null;
  zecTxid: string | null;
  hasCode: boolean;
  createdAt: string;
  updatedAt: string;
  simulatedSwap: boolean;
  settlement: "bitrefill-test-product" | "bitrefill-store-credit" | "1click-swap";
}

export interface EventView {
  id: number;
  purchaseId: string | null;
  type: string;
  fromStatus: Status | null;
  toStatus: Status | null;
  actor: Actor;
  data: Record<string, unknown>;
  simulated: boolean;
  createdAt: string;
}

export interface BudgetView {
  leftTodayCents: number;
  leftMonthCents: number;
  purchasesLeftToday: number;
  autoApproveUpToCents: number;
  paused: boolean;
  vaultSpendableZats: string;
  vaultSpendableZec: string;
  /** Demo mode only: real Bitrefill orders paid from store credit */
  realOrders: {
    orderMode: "test" | "balance";
    maxOrderCents: number;
    maxTotalCents: number;
    spentCents: number;
    leftCents: number;
  } | null;
}

export interface Policy {
  paused: boolean;
  maxPerPurchaseCents: number;
  dailyLimitCents: number;
  monthlyLimitCents: number;
  maxPurchasesPerDay: number;
  requireApprovalAboveCents: number;
  approveAllFirstTimeProducts: boolean;
  allowedTypes: ProductType[];
  allowedCountries: string[];
  blockedProductIds: string[];
  updatedAt: string;
}

export interface Receipt {
  v: 1;
  id: string;
  a: string;
  t: number;
  m: Mode;
  p: string;
  n: string;
  fv: string;
  fc: string;
  u: number;
  z: string;
  i?: string;
  o?: string;
  x: string;
}

export interface ReceiptRecord {
  txid: string;
  minedHeight: number | null;
  receipt: Receipt;
}

export interface WalletInfo {
  fundingAddress: string;
  balance: {
    spendableZats: string;
    pendingZats: string;
    totalZats: string;
    spendableZec: string;
    /** null when no live ZEC price is available (never a made-up rate) */
    usdEstimate: string | null;
  };
  receiptsAddress: string;
}

export interface HealthInfo {
  ok: boolean;
  mode: Mode;
  network: "main" | "test";
  version: string;
  vault: { ok: boolean };
  fulfilment: "bitrefill-test-product" | "bitrefill-store-credit" | "1click-swap";
  llm: { provider: string; model: string };
  merchant: "api" | "mock";
}

