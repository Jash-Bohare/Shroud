import { getEnv } from "../config/env.js";
import { MerchantAdapter } from "../merchant/types.js";
import { ShroudError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { VaultService } from "../zcash/vault.js";
import { PurchaseRow, SwapExecutor, SwapPollResult, SwapPrep } from "./types.js";
import { request } from "node:https";

export class LiveSwapExecutor implements SwapExecutor {
  readonly mode = "live" as const;
  private readonly vault: VaultService;
  private readonly merchant: MerchantAdapter;
  private readonly oneclickBaseUrl: string;
  private readonly zecAssetId: string;
  private readonly paymentMethod: string;
  private readonly quoteDeadlineMin: number;

  constructor(opts: { vault: VaultService; merchant: MerchantAdapter }) {
    const env = getEnv();
    this.vault = opts.vault;
    this.merchant = opts.merchant;
    this.oneclickBaseUrl = env.ONECLICK_BASE_URL;
    this.zecAssetId = env.ONECLICK_ZEC_ASSET_ID;
    this.paymentMethod = env.BITREFILL_PAYMENT_METHOD;
    this.quoteDeadlineMin = env.QUOTE_DEADLINE_MIN;
  }

  private async oneclickRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.oneclickBaseUrl);
    const payload = body ? JSON.stringify(body) : undefined;

    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: url.pathname + url.search,
          method,
          family: 4,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
            Accept: "application/json",
            "User-Agent": "Shroud/1.0"
          },
          timeout: 10_000
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              return reject(new Error(`1Click HTTP ${res.statusCode}: ${data}`));
            }
            try {
              resolve(data ? JSON.parse(data) : ({} as T));
            } catch (err: any) {
              reject(err);
            }
          });
        }
      );

      req.on("timeout", () => req.destroy(new Error("1Click request timeout")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async prepare(p: PurchaseRow): Promise<SwapPrep> {
    const env = getEnv();
    const refundAddress = await this.vault.newRefundAddress();

    // 1. Create real crypto invoice with Bitrefill
    const invoice = await this.merchant.createCryptoInvoice(
      {
        productId: p.product_id,
        packageId: p.package_id || undefined,
        value: p.value_num !== null ? Number(p.value_num) : undefined
      },
      this.paymentMethod,
      env.BITREFILL_REFUND_ADDRESS || refundAddress
    );

    // 2. Request live swap quote from 1Click
    const deadline = new Date(Date.now() + this.quoteDeadlineMin * 60 * 1000).toISOString();
    const quoteRes = await this.oneclickRequest<any>("/v0/quote", "POST", {
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: env.SLIPPAGE_BPS,
      originAsset: this.zecAssetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: env.ONECLICK_USDC_ASSET_ID,
      amount: String(invoice.payAmountBase),
      refundTo: refundAddress,
      refundType: "ORIGIN_CHAIN",
      recipient: invoice.payAddress,
      recipientType: "DESTINATION_CHAIN",
      deadline
    });

    const depositAddress = quoteRes.quote?.depositAddress || quoteRes.depositAddress;
    const amountIn = quoteRes.quote?.amountIn || quoteRes.amountIn;

    if (!depositAddress || !amountIn) {
      throw new ShroudError("QUOTE_FAILED", "1Click quote missing depositAddress or amountIn");
    }

    return {
      payTo: depositAddress,
      payZats: BigInt(amountIn),
      swapRef: depositAddress,
      quoteExpiresAt: deadline,
      invoiceId: invoice.invoiceId,
      priceCents: invoice.priceCents
    };
  }

  async afterPaid(p: PurchaseRow): Promise<void> {
    if (!p.zec_txid || !p.pay_to) return;

    try {
      await this.oneclickRequest("/v0/deposit", "POST", {
        txHash: p.zec_txid,
        depositAddress: p.pay_to
      });
    } catch (err: any) {
      // Best effort notification; 1Click indexer independently tracks deposits
      logger.warn({ err: err.message, txid: p.zec_txid }, "1Click submitDepositTx notification failed");
    }
  }

  async poll(p: PurchaseRow): Promise<SwapPollResult> {
    if (!p.swap_ref) return "PENDING";

    try {
      const res = await this.oneclickRequest<any>(
        `/v0/status?depositAddress=${encodeURIComponent(p.swap_ref)}`,
        "GET"
      );

      const status = String(res.status || "").toUpperCase();
      if (status === "SUCCESS") return "SETTLED";
      if (status === "REFUNDED") return "REFUNDED";
      if (status === "FAILED" || status === "INCOMPLETE_DEPOSIT") return "FAILED";

      return "PENDING";
    } catch (err: any) {
      logger.warn({ err: err.message, swapRef: p.swap_ref }, "1Click poll failed");
      return "PENDING";
    }
  }

  async order(p: PurchaseRow): Promise<{ invoiceId: string; orderId: string }> {
    if (!p.merchant_invoice_id) {
      throw new ShroudError("MERCHANT_ERROR", "Missing merchant invoice ID");
    }

    const invoice = await this.merchant.getInvoice(p.merchant_invoice_id);
    if (invoice.status === "rejected") {
      throw new ShroudError("MERCHANT_REJECTED", "Bitrefill invoice was rejected or blocked");
    }

    if (invoice.status === "completed" && invoice.orderIds.length > 0) {
      return {
        invoiceId: p.merchant_invoice_id,
        orderId: invoice.orderIds[0]
      };
    }

    throw new ShroudError("MERCHANT_ERROR", "Invoice is not yet completed");
  }
}

