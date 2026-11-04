import Database from "better-sqlite3";
import { getEnv } from "../config/env.js";
import { getDb } from "../db/db.js";
import { MerchantAdapter } from "../merchant/types.js";
import { encryptCode } from "../shared/crypto.js";
import { ShroudError } from "../shared/errors.js";
import { generateAttemptId } from "../shared/ids.js";
import { logger } from "../shared/logger.js";
import { PolicyStore } from "../policy/store.js";
import { VaultService } from "../zcash/vault.js";
import { transition } from "./state-machine.js";
import { PurchaseRow, SETTLE_BITREFILL_BALANCE, SwapExecutor, isSimulatedSettlement } from "./types.js";

export class PurchaseWorker {
  private readonly db: Database.Database;
  private readonly vault: VaultService;
  private readonly merchant: MerchantAdapter;
  private readonly executor: SwapExecutor;
  private readonly policyStore: PolicyStore;
  private isRunning = false;
  private isSyncing = false;
  private timer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly tickIntervalMs: number;
  private readonly maxRetries = 5;

  constructor(opts: {
    db?: Database.Database;
    vault: VaultService;
    merchant: MerchantAdapter;
    executor: SwapExecutor;
    policyStore?: PolicyStore;
    tickIntervalMs?: number;
  }) {
    const env = getEnv();
    this.db = opts.db ?? getDb();
    this.vault = opts.vault;
    this.merchant = opts.merchant;
    this.executor = opts.executor;
    this.policyStore = opts.policyStore ?? new PolicyStore(this.db);
    this.tickIntervalMs = opts.tickIntervalMs ?? env.WORKER_TICK_MS;
  }

  start(): void {
    if (this.timer) return;
    logger.info("Starting PurchaseWorker loop");
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err: err.message }, "Unhandled error in PurchaseWorker tick");
      });
    }, this.tickIntervalMs);

    // Sync once at boot: until the first sync the wallet reports spendable=0,
    // so the dashboard/Telegram balance would read $0 for the first 30 s.
    this.runPeriodicSync().catch((err) => {
      logger.warn({ err: err.message }, "Initial wallet sync failed");
    });

    // Periodic lightwalletd sync every 30 seconds
    this.syncTimer = setInterval(() => {
      this.runPeriodicSync().catch((err) => {
        logger.warn({ err: err.message }, "Background sync error in worker");
      });
    }, 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    logger.info("Stopped PurchaseWorker loop");
  }

  private async runPeriodicSync(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      await this.vault.sync();
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Executes a single processing tick over all active purchases.
   */
  async tick(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Find active purchases in non-terminal states
      const activePurchases = this.db
        .prepare(
          `SELECT * FROM purchases
           WHERE status IN ('AWAITING_APPROVAL', 'APPROVED', 'PAYING', 'PAID', 'SWAPPING', 'SWAPPED', 'ORDERING')
           ORDER BY created_at ASC`
        )
        .all() as PurchaseRow[];

      for (const p of activePurchases) {
        try {
          await this.step(p);
        } catch (err: any) {
          const newRetryCount = Number(p.retry_count || 0) + 1;
          // Placing a real (store-credit) order is never retried: the request may have been
          // charged even though it errored, and a retry would buy the product twice.
          const realOrderAttempted =
            p.status === "SWAPPED" && p.swap_ref === SETTLE_BITREFILL_BALANCE;
          const isFinal = newRetryCount >= this.maxRetries || realOrderAttempted;

          logger.warn(
            {
              purchaseId: p.id,
              status: p.status,
              attempt: newRetryCount,
              isFinal,
              err: err.message
            },
            "Worker error during step"
          );

          if (isFinal) {
            // step() may already have advanced the row (e.g. APPROVED -> PAYING before the
            // broadcast threw), so use the current status for the compare-and-set.
            const current = this.db
              .prepare(`SELECT status FROM purchases WHERE id = ?`)
              .get(p.id) as { status: PurchaseRow["status"] } | undefined;
            transition(this.db, p.id, current?.status ?? p.status, "FAILED", {
              data: {
                error_code: err.code || "WORKER_ERROR",
                error_message: err.message,
                retry_count: newRetryCount
              },
              actor: "system",
              note: realOrderAttempted
                ? `Real Bitrefill order failed and was NOT retried (check bitrefill.com before trying again): ${err.message}`
                : `Max retries exceeded: ${err.message}`
            });
          } else {
            this.db
              .prepare(
                `UPDATE purchases SET retry_count = ?, error_message = ?, updated_at = ? WHERE id = ?`
              )
              .run(newRetryCount, err.message, new Date().toISOString(), p.id);
          }
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  async step(p: PurchaseRow): Promise<void> {
    switch (p.status) {
      case "AWAITING_APPROVAL": {
        if (p.approval_expires_at && new Date() > new Date(p.approval_expires_at)) {
          transition(this.db, p.id, "AWAITING_APPROVAL", "EXPIRED", {
            actor: "system",
            note: "Approval window expired"
          });
        }
        break;
      }

      case "APPROVED": {
        // Kill switch: halt before broadcast if spending is paused
        if (this.policyStore.get().paused) {
          logger.warn({ purchaseId: p.id }, "Payment halted: spending is paused by owner");
          return;
        }

        // Crash-safety rule 1: Enter PAYING with attempt_id before broadcasting transaction
        const attemptId = generateAttemptId();

        transition(this.db, p.id, "APPROVED", "PAYING", {
          data: { attempt_id: attemptId },
          actor: "system",
          note: `Preparing payment with attempt ${attemptId}`,
          simulated: false
        });

        // Execute payment via vault
        const payResult = await this.vault.payWithReceipt({
          to: p.pay_to!,
          zats: BigInt(p.pay_zats!),
          toMemo: p.pay_to_memo || undefined,
          attemptId,
          receipt: {
            id: p.id,
            attemptId,
            mode: p.mode,
            productId: p.product_id,
            productName: p.product_name,
            faceValue: p.face_value,
            faceCurrency: p.face_currency,
            priceCents: Number(p.price_cents),
            zatsPaid: BigInt(p.pay_zats!),
            swapRef: p.swap_ref || "desk",
            invoiceId: p.merchant_invoice_id || undefined
          }
        });

        transition(this.db, p.id, "PAYING", "PAID", {
          data: { zec_txid: payResult.txid },
          actor: "system",
          note: `Broadcasted transaction ${payResult.txid}`,
          simulated: false
        });
        break;
      }

      case "PAYING": {
        // Recover from server crash or restart in PAYING state
        if (p.zec_txid) {
          transition(this.db, p.id, "PAYING", "PAID", {
            data: { zec_txid: p.zec_txid },
            actor: "system",
            note: "Recovered existing transaction ID"
          });
          break;
        }

        // Check on-chain receipts for existing attempt_id
        if (p.attempt_id) {
          const onchain = await this.vault.findReceiptByAttempt(p.attempt_id);
          if (onchain) {
            transition(this.db, p.id, "PAYING", "PAID", {
              data: { zec_txid: onchain.txid },
              actor: "system",
              note: `Recovered on-chain transaction ${onchain.txid}`
            });
            break;
          }
        }

        // If not found, retry payment with same attempt_id
        const attemptId = p.attempt_id || generateAttemptId();
        const payResult = await this.vault.payWithReceipt({
          to: p.pay_to!,
          zats: BigInt(p.pay_zats!),
          toMemo: p.pay_to_memo || undefined,
          attemptId,
          receipt: {
            id: p.id,
            attemptId,
            mode: p.mode,
            productId: p.product_id,
            productName: p.product_name,
            faceValue: p.face_value,
            faceCurrency: p.face_currency,
            priceCents: Number(p.price_cents),
            zatsPaid: BigInt(p.pay_zats!),
            swapRef: p.swap_ref || "desk",
            invoiceId: p.merchant_invoice_id || undefined
          }
        });

        transition(this.db, p.id, "PAYING", "PAID", {
          data: { zec_txid: payResult.txid },
          actor: "system",
          note: `Payment retry broadcasted ${payResult.txid}`
        });
        break;
      }

      case "PAID": {
        await this.executor.afterPaid(p);
        transition(this.db, p.id, "PAID", "SWAPPING", {
          actor: "system",
          simulated: isSimulatedSettlement(p)
        });
        break;
      }

      case "SWAPPING": {
        const pollResult = await this.executor.poll(p);
        if (pollResult === "SETTLED") {
          transition(this.db, p.id, "SWAPPING", "SWAPPED", {
            actor: "system",
            simulated: isSimulatedSettlement(p)
          });
        } else if (pollResult === "REFUNDED") {
          transition(this.db, p.id, "SWAPPING", "REFUNDED", {
            data: { error_code: "SWAP_REFUNDED", error_message: "Swap funds were refunded" },
            actor: "system"
          });
        } else if (pollResult === "FAILED") {
          transition(this.db, p.id, "SWAPPING", "FAILED", {
            data: { error_code: "SWAP_FAILED", error_message: "Swap execution failed or timed out" },
            actor: "system"
          });
        }
        break;
      }

      case "SWAPPED": {
        const orderResult = await this.executor.order(p);
        transition(this.db, p.id, "SWAPPED", "ORDERING", {
          data: {
            merchant_invoice_id: orderResult.invoiceId,
            merchant_order_id: orderResult.orderId
          },
          actor: "system",
          simulated: isSimulatedSettlement(p)
        });
        break;
      }

      case "ORDERING": {
        if (!p.merchant_order_id) {
          if (!p.merchant_invoice_id) {
            throw new ShroudError("MERCHANT_ERROR", "Missing merchant order ID in ORDERING state");
          }
          // Order id arrived after auto-pay: read it from the existing invoice (never re-order)
          const inv = await this.merchant.getInvoice(p.merchant_invoice_id);
          if (inv.orderIds[0]) {
            this.db
              .prepare(`UPDATE purchases SET merchant_order_id = ?, updated_at = ? WHERE id = ? AND status = 'ORDERING'`)
              .run(inv.orderIds[0], new Date().toISOString(), p.id);
          } else if (inv.status === "rejected" || inv.status === "expired") {
            transition(this.db, p.id, "ORDERING", "FAILED", {
              data: { error_code: "MERCHANT_REJECTED", error_message: `Bitrefill invoice ${inv.status}` },
              actor: "system"
            });
          }
          break;
        }

        const orderDetail = await this.merchant.getOrder(p.merchant_order_id);
        if (orderDetail.status === "delivered") {
          const rawCode =
            orderDetail.redemption.code ||
            orderDetail.redemption.link ||
            "CONFIRMED_NO_CODE";

          const { ciphertext, codeHash } = encryptCode(rawCode);

          transition(this.db, p.id, "ORDERING", "DELIVERED", {
            data: {
              code_ciphertext: ciphertext,
              code_hash: codeHash
            },
            actor: "system",
            note: "Order delivered successfully",
            simulated: isSimulatedSettlement(p)
          });
        } else if (orderDetail.status === "failed" || orderDetail.status === "canceled") {
          transition(this.db, p.id, "ORDERING", "FAILED", {
            data: {
              error_code: "MERCHANT_ORDER_FAILED",
              error_message: `Merchant order ended with status ${orderDetail.status}`
            },
            actor: "system"
          });
        }
        break;
      }
    }
  }
}

