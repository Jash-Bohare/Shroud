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

export const TERMINAL_STATUSES: Status[] = [
  "DENIED",
  "REJECTED",
  "EXPIRED",
  "DELIVERED",
  "REFUNDED",
  "FAILED"
];

export const COUNTED_STATUSES: Status[] = [
  "APPROVED",
  "PAYING",
  "PAID",
  "SWAPPING",
  "SWAPPED",
  "ORDERING",
  "DELIVERED"
];

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
  /** How the order is fulfilled: Bitrefill test product, real product via store credit, or 1Click (live). */
  settlement: Settlement;
}

export type Settlement = "bitrefill-test-product" | "bitrefill-store-credit" | "1click-swap";

export interface BudgetView {
  leftTodayCents: number;
  leftMonthCents: number;
  purchasesLeftToday: number;
  autoApproveUpToCents: number;
  paused: boolean;
  vaultSpendableZats: string;
  vaultSpendableZec: string;
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

