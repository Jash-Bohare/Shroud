import Database from "better-sqlite3";
import { getEnv } from "../config/env.js";
import { getDb } from "../db/db.js";
import { MerchantAdapter } from "../merchant/types.js";
import { ShroudError } from "../shared/errors.js";
import { centsToUsd, scaleDemoZats } from "../shared/money.js";
import { VaultService } from "../zcash/vault.js";
import {
  PurchaseRow,
  SETTLE_BITREFILL_BALANCE,
  SETTLE_TEST_PRODUCT,
  SwapExecutor,
  SwapPollResult,
  SwapPrep
} from "./types.js";

export { SETTLE_BITREFILL_BALANCE, SETTLE_TEST_PRODUCT };

export type DeskOrderMode = "test" | "balance";

/** Statuses whose price counts against the real-order (store credit) budget. */
const COMMITTED = `('APPROVED','PAYING','PAID','SWAPPING','SWAPPED','ORDERING','DELIVERED')`;

/**
 * Testnet settlement through the Shroud "desk".
 *
 * The vault pays the desk account in shielded ZEC (TAZ) with memo `SHROUD-DESK <purchase id>`.
 * The desk confirms that exact payment by memo, amount and confirmations, then fulfils the
 * order on Bitrefill: either the real product from its prepaid store credit ("balance" mode)
 * or Bitrefill's free test product ("test" mode). 1Click is mainnet-only, so no swap happens
 * on testnet; the desk plays the merchant of record.
 */
export class DemoSwapExecutor implements SwapExecutor {
  readonly mode = "demo" as const;
  private readonly vault: VaultService;
  private readonly merchant: MerchantAdapter;
  private readonly amountScale: number;
  private readonly minDemoZats: bigint;
  private readonly minConf: number;
  private readonly swapTimeoutMs: number;
  private readonly orderMode: DeskOrderMode;
  private readonly maxOrderCents: number;
  private readonly maxTotalCents: number;
  private readonly dbOverride?: Database.Database;

  constructor(opts: {
    vault: VaultService;
    merchant: MerchantAdapter;
    amountScale?: number;
    minDemoZats?: bigint;
    minConf?: number;
    swapTimeoutMs?: number;
    orderMode?: DeskOrderMode;
    maxOrderCents?: number;
    maxTotalCents?: number;
    db?: Database.Database;
  }) {
    const env = getEnv();
    this.vault = opts.vault;
    this.merchant = opts.merchant;
    this.amountScale = opts.amountScale ?? env.DEMO_AMOUNT_SCALE;
    this.minDemoZats = opts.minDemoZats ?? env.MIN_DEMO_ZATS;
    this.minConf = opts.minConf ?? env.DEMO_DESK_MIN_CONF;
    this.swapTimeoutMs = opts.swapTimeoutMs ?? env.SWAP_TIMEOUT_MIN * 60 * 1000;
    this.orderMode = opts.orderMode ?? env.BITREFILL_ORDER_MODE;
    this.maxOrderCents = opts.maxOrderCents ?? env.BITREFILL_BALANCE_MAX_ORDER_CENTS;
    this.maxTotalCents = opts.maxTotalCents ?? env.BITREFILL_BALANCE_MAX_TOTAL_CENTS;
    this.dbOverride = opts.db;
  }

  private get db(): Database.Database {
    return this.dbOverride ?? getDb();
  }

  /** Store-credit budget for real orders, for the dashboard and /budget. */
  realOrderBudget(): {
    orderMode: DeskOrderMode;
    maxOrderCents: number;
    maxTotalCents: number;
    spentCents: number;
    leftCents: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(price_cents), 0) AS spent FROM purchases WHERE swap_ref = ? AND status IN ${COMMITTED}`
      )
      .get(SETTLE_BITREFILL_BALANCE) as { spent: number | bigint };
    const spentCents = Number(row.spent);
    return {
      orderMode: this.orderMode,
      maxOrderCents: this.maxOrderCents,
      maxTotalCents: this.maxTotalCents,
      spentCents,
      leftCents: Math.max(0, this.maxTotalCents - spentCents)
    };
  }

  /** Why a real (store-credit) order of this price would break a cap, or null if it fits. */
  private balanceBudgetProblem(priceCents: number, excludeId: string | null): string | null {
    if (priceCents > this.maxOrderCents) {
      return `Real Bitrefill orders are capped at ${centsToUsd(this.maxOrderCents)} each; this one is ${centsToUsd(priceCents)}.`;
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(price_cents), 0) AS spent FROM purchases
         WHERE swap_ref = ? AND id != ? AND status IN ${COMMITTED}`
      )
      .get(SETTLE_BITREFILL_BALANCE, excludeId ?? "") as { spent: number | bigint };
    const spent = Number(row.spent);
    if (spent + priceCents > this.maxTotalCents) {
      return `Store-credit budget for real orders: ${centsToUsd(Math.max(0, this.maxTotalCents - spent))} left of ${centsToUsd(this.maxTotalCents)}.`;
    }
    return null;
  }

  /** Throws if a real (store-credit) order of this price would break the per-order or total cap. */
  private assertBalanceBudget(p: PurchaseRow): void {
    const problem = this.balanceBudgetProblem(Number(p.price_cents), p.id);
    if (problem) throw new ShroudError("MERCHANT_REJECTED", problem);
  }

  preflight(priceCents: number): string | null {
    return this.orderMode === "balance" ? this.balanceBudgetProblem(priceCents, null) : null;
  }

  async prepare(p: PurchaseRow): Promise<SwapPrep> {
    const swapRef = this.orderMode === "balance" ? SETTLE_BITREFILL_BALANCE : SETTLE_TEST_PRODUCT;
    if (swapRef === SETTLE_BITREFILL_BALANCE) this.assertBalanceBudget(p);

    const deskAddress = await this.vault.getDeskAddress();
    const payZats = scaleDemoZats(BigInt(p.quoted_zats), this.amountScale, this.minDemoZats);

    return {
      payTo: deskAddress,
      payZats,
      payToMemo: `SHROUD-DESK ${p.id}`,
      swapRef,
      quoteExpiresAt: p.quote_expires_at || undefined,
      priceCents: p.price_cents
    };
  }

  async afterPaid(_p: PurchaseRow): Promise<void> {
    // The desk watches its own account; nothing to notify.
  }

  async poll(p: PurchaseRow): Promise<SwapPollResult> {
    if (!p.zec_txid) return "PENDING";

    // Match the payment to the order by memo, then check amount and confirmations.
    const paid = await this.vault.findDeskPayment(p.pay_to_memo || `SHROUD-DESK ${p.id}`);
    if (paid) {
      const owed = BigInt(p.pay_zats ?? p.quoted_zats);
      if (paid.valueZats < owed) return "FAILED"; // underpaid: never fulfil
      if (paid.confirmations >= this.minConf) return "SETTLED";
    }

    if (Date.now() - new Date(p.created_at).getTime() > this.swapTimeoutMs) {
      return "FAILED";
    }
    return "PENDING";
  }

  async order(p: PurchaseRow): Promise<{ invoiceId: string; orderId: string }> {
    const sel = {
      productId: p.product_id,
      packageId: p.package_id || undefined,
      value: p.value_num !== null ? Number(p.value_num) : undefined
    };

    if (p.swap_ref === SETTLE_BITREFILL_BALANCE) {
      // Re-check right before spending real credit (the cap may have been used up meanwhile)
      this.assertBalanceBudget(p);
      return await this.merchant.placeBalanceOrder(sel);
    }
    return await this.merchant.placeTestOrder(sel, p.product_type);
  }
}
