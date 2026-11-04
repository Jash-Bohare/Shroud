import { Evaluation } from "../policy/types.js";
import { centsToUsd, zatsToZecExact } from "../shared/money.js";
import { Mode, ProductType, PurchaseView, Settlement, Source, Status } from "../shared/types.js";

/** swap_ref values. Also written into the SHRD1 receipt (`x`), so an auditor sees how it settled. */
export const SETTLE_TEST_PRODUCT = "desk"; // Bitrefill test product stands in for the real one
export const SETTLE_BITREFILL_BALANCE = "desk-balance"; // real product, paid from Bitrefill store credit

/**
 * True when settlement uses a stand-in: demo mode with the Bitrefill test product.
 * Policy, approval and the shielded payment are always real; only swap/order/delivery can be.
 */
export function isSimulatedSettlement(p: { mode: Mode; swap_ref: string | null }): boolean {
  return p.mode === "demo" && p.swap_ref !== SETTLE_BITREFILL_BALANCE;
}

export function settlementOf(p: { mode: Mode; swap_ref: string | null }): Settlement {
  if (p.mode === "live") return "1click-swap";
  return p.swap_ref === SETTLE_BITREFILL_BALANCE ? "bitrefill-store-credit" : "bitrefill-test-product";
}

export interface PurchaseRow {
  id: string;
  status: Status;
  mode: Mode;
  source: Source;
  reason: string;
  product_id: string;
  product_name: string;
  product_type: ProductType;
  country: string | null;
  package_id: string | null;
  value_num: number | null;
  face_value: string;
  face_currency: string;
  price_cents: number;
  price_source: "oneclick" | "coingecko" | "fixed";
  quoted_zats: bigint | number;
  pay_zats: bigint | number | null;
  pay_to: string | null;
  pay_to_memo: string | null;
  swap_ref: string | null;
  quote_expires_at: string | null;
  policy_decision: string | null;
  policy_reasons: string;
  approval_nonce: string | null;
  approval_expires_at: string | null;
  attempt_id: string | null;
  zec_txid: string | null;
  merchant_invoice_id: string | null;
  merchant_order_id: string | null;
  code_ciphertext: string | null;
  code_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export function rowToPurchaseView(row: PurchaseRow): PurchaseView {
  const policyReasons: string[] = (() => {
    try {
      return JSON.parse(row.policy_reasons || "[]");
    } catch {
      return [];
    }
  })();

  const quotedZatsBigInt =
    row.quoted_zats !== undefined && row.quoted_zats !== null ? BigInt(row.quoted_zats) : 0n;
  const paidZatsBigInt =
    row.pay_zats !== undefined && row.pay_zats !== null ? BigInt(row.pay_zats) : null;
  const displayZats = paidZatsBigInt !== null ? paidZatsBigInt : quotedZatsBigInt;

  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    productId: row.product_id || "",
    productName: row.product_name || "",
    productType: row.product_type || "other",
    country: row.country ?? null,
    faceValue: row.face_value || "0",
    faceCurrency: row.face_currency || "USD",
    priceCents: row.price_cents !== undefined && row.price_cents !== null ? Number(row.price_cents) : 0,
    priceUsd: centsToUsd(
      row.price_cents !== undefined && row.price_cents !== null ? Number(row.price_cents) : 0
    ),
    quotedZats: String(quotedZatsBigInt),
    paidZats: paidZatsBigInt !== null ? String(paidZatsBigInt) : null,
    zec: zatsToZecExact(displayZats),
    priceSource: row.price_source || "fixed",
    reason: row.reason || "",
    source: row.source || "agent",
    policyReasons,
    policyDecision: row.policy_decision,
    approvalNonce: row.approval_nonce,
    approvalExpiresAt: row.approval_expires_at,
    zecTxid: row.zec_txid,
    hasCode: !!row.code_ciphertext,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    simulatedSwap: isSimulatedSettlement(row),
    settlement: settlementOf(row)
  };
}

export interface QuoteView {
  productId: string;
  productName: string;
  productType: ProductType;
  country: string | null;
  faceValue: string;
  faceCurrency: string;
  priceCents: number;
  priceUsd: string;
  quotedZats: string;
  quotedZec: string;
  priceSource: "oneclick" | "coingecko" | "fixed";
  expiresAt: string;
  policy?: Evaluation;
}

export interface SwapPrep {
  payTo: string;
  payZats: bigint;
  payToMemo?: string;
  swapRef: string;
  quoteExpiresAt?: string;
  invoiceId?: string;
  priceCents?: number;
}

export type SwapPollResult = "PENDING" | "SETTLED" | "REFUNDED" | "FAILED";

export interface SwapExecutor {
  readonly mode: Mode;
  prepare(p: PurchaseRow): Promise<SwapPrep>;
  afterPaid(p: PurchaseRow): Promise<void>;
  poll(p: PurchaseRow): Promise<SwapPollResult>;
  order(p: PurchaseRow): Promise<{ invoiceId: string; orderId: string }>;
  /** Returns why this price can't be fulfilled right now (e.g. store-credit cap), or null. */
  preflight?(priceCents: number): string | null;
}

