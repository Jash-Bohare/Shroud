import { request } from "node:https";
import { getEnv } from "../config/env.js";
import { ShroudError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { ProductType } from "../shared/types.js";
import {
  CryptoInvoice,
  InvoiceStatus,
  MerchantAdapter,
  OrderStatus,
  PriceInfo,
  ProductDetail,
  ProductSummary,
  Selection
} from "./types.js";

interface HttpRequestOptions {
  method: string;
  path: string;
  body?: unknown;
}

export class BitrefillMerchantAdapter implements MerchantAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fxUsdPer: Record<string, number>;

  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    const env = getEnv();
    this.baseUrl = opts?.baseUrl ?? "https://api.bitrefill.com/v2";
    this.apiKey = opts?.apiKey ?? env.BITREFILL_API_KEY;
    this.timeoutMs = opts?.timeoutMs ?? 10_000;
    this.fxUsdPer = env.FX_USD_PER ?? { INR: 0.012, EUR: 1.08, USD: 1.0 };
  }

  private async request<T>(options: HttpRequestOptions, retries = 2): Promise<T> {
    const cleanBase = this.baseUrl.replace(/\/+$/, "");
    const cleanPath = options.path.startsWith("/") ? options.path : `/${options.path}`;
    const url = new URL(`${cleanBase}${cleanPath}`);
    const payload = options.body ? JSON.stringify(options.body) : undefined;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": "Shroud/1.0"
    };

    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }

    let attempt = 0;
    while (attempt <= retries) {
      attempt++;
      try {
        const res = await new Promise<{ status: number; data: string }>((resolve, reject) => {
          const req = request(
            {
              hostname: url.hostname,
              port: url.port ? Number(url.port) : 443,
              path: url.pathname + url.search,
              method: options.method,
              family: 4,
              headers,
              timeout: this.timeoutMs
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                resolve({ status: res.statusCode || 0, data });
              });
            }
          );

          req.on("timeout", () => {
            req.destroy(new Error(`Bitrefill request timeout after ${this.timeoutMs}ms`));
          });

          req.on("error", reject);
          if (payload) req.write(payload);
          req.end();
        });

        if (res.status >= 200 && res.status < 300) {
          return (res.data ? JSON.parse(res.data) : {}) as T;
        }

        // Retry on 429 or 5xx
        if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
          const backoff = attempt * 500;
          logger.warn(
            { status: res.status, attempt, backoff },
            "Bitrefill temporary error, retrying"
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        if (res.status === 404) {
          throw new ShroudError("PRODUCT_NOT_FOUND", `Resource not found: ${options.path}`);
        }

        let errMessage = `Bitrefill HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(res.data);
          if (parsed.message || parsed.error) {
            errMessage = parsed.message || parsed.error;
          }
        } catch {
          // ignore json parse failure
        }

        throw new ShroudError("MERCHANT_ERROR", `Bitrefill error: ${errMessage}`, {
          status: res.status
        });
      } catch (err: any) {
        if (attempt <= retries && (err.code === "ECONNRESET" || err.message?.includes("timeout"))) {
          const backoff = attempt * 500;
          logger.warn({ err: err.message, attempt, backoff }, "Bitrefill network error, retrying");
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        if (err instanceof ShroudError) throw err;
        throw new ShroudError("MERCHANT_ERROR", `Bitrefill network error: ${err.message}`);
      }
    }

    throw new ShroudError("MERCHANT_ERROR", "Bitrefill max retries exceeded");
  }

  private mapProductType(rawType: string, categories: string[] = []): ProductType {
    const combined = `${rawType} ${categories.join(" ")}`.toLowerCase();
    if (combined.includes("esim")) return "esim";
    if (/refill|topup|top-up|phone|data|mobile/.test(combined)) return "refill";
    if (combined.includes("bill")) return "bill";
    return "giftcard";
  }

  private formatDenominations(p: any): string {
    const curr = p.currency === "INR" ? "₹" : p.currency === "EUR" ? "€" : p.currency === "USD" ? "$" : `${p.currency} `;
    if (p.range) {
      return `${curr}${p.range.min}–${curr}${p.range.max}`;
    }
    if (Array.isArray(p.packages) && p.packages.length > 0) {
      // eSIM packages are named plans ("1GB, 7 Days"), not amounts: no currency prefix
      const vals = p.packages
        .slice(0, 3)
        .map((pkg: any) => (/^\d+(\.\d+)?$/.test(String(pkg.value)) ? `${curr}${pkg.value}` : String(pkg.value)));
      // " | " separator: plan names themselves contain commas
      return p.packages.length > 3 ? `${vals.join(" | ")} ...` : vals.join(" | ");
    }
    return "Variable";
  }

  async search(
    q: string,
    opts?: { country?: string; type?: ProductType; limit?: number }
  ): Promise<ProductSummary[]> {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.country) params.set("country_code", opts.country);

    const res = await this.request<any>({
      method: "GET",
      path: `/products/search?${params.toString()}`
    });

    const items: any[] = res.data ?? [];
    let summaries: ProductSummary[] = items.map((p) => {
      const type = this.mapProductType(p.type ?? "", p.categories ?? []);
      return {
        id: p.id,
        name: p.name ?? p.base_name,
        type,
        country: p.country_code ?? null,
        currency: p.currency ?? "USD",
        inStock: p.in_stock !== false,
        denominations: this.formatDenominations(p)
      };
    });

    if (opts?.type) {
      summaries = summaries.filter((s) => s.type === opts.type);
    }
    if (opts?.country) {
      summaries = summaries.filter(
        (s) => !s.country || s.country.toUpperCase() === opts.country!.toUpperCase()
      );
    }
    if (opts?.limit && summaries.length > opts.limit) {
      summaries = summaries.slice(0, opts.limit);
    }

    return summaries;
  }

  async getProduct(id: string): Promise<ProductDetail> {
    const res = await this.request<any>({
      method: "GET",
      path: `/products/${encodeURIComponent(id)}`
    });

    const p = res.data ?? res;
    if (!p || !p.id) {
      throw new ShroudError("PRODUCT_NOT_FOUND", `Product "${id}" not found`);
    }

    const type = this.mapProductType(p.type ?? "", p.categories ?? []);
    const currency = String(p.currency ?? "USD").toUpperCase();
    const packages = Array.isArray(p.packages)
      ? p.packages.map((pkg: any) => ({
          id: pkg.id,
          value: String(pkg.value),
          priceCents: this.packageAmountToUsdCents(pkg.amount, currency)
        }))
      : undefined;

    return {
      id: p.id,
      name: p.name ?? p.base_name,
      type,
      country: p.country_code ?? null,
      currency: p.currency ?? "USD",
      inStock: p.in_stock !== false,
      denominations: this.formatDenominations(p),
      packages,
      range: p.range
        ? {
            min: Number(p.range.min),
            max: Number(p.range.max),
            step: Number(p.range.step || 1)
          }
        : undefined,
      rawType: p.type ?? (p.categories?.[0] || "giftcard")
    };
  }

  async price(sel: Selection): Promise<PriceInfo> {
    const product = await this.getProduct(sel.productId);

    if (!product.inStock) {
      throw new ShroudError("OUT_OF_STOCK", `Product "${product.name}" is currently out of stock`);
    }

    // 1. Package selection
    if (sel.packageId) {
      const pkg = product.packages?.find((p) => p.id === sel.packageId);
      if (!pkg) {
        throw new ShroudError(
          "INVALID_SELECTION",
          `Package "${sel.packageId}" not found for product "${product.name}"`
        );
      }

      if (pkg.priceCents !== undefined && pkg.priceCents > 0) {
        return {
          priceCents: pkg.priceCents,
          faceValue: pkg.value,
          faceCurrency: product.currency,
          source: "bitrefill"
        };
      }

      // Convert from face value using FX table
      const numVal = parseFloat(pkg.value);
      return this.convertFx(numVal, pkg.value, product.currency);
    }

    // 2. Open range / direct value selection
    if (sel.value !== undefined) {
      if (product.range) {
        if (sel.value < product.range.min || sel.value > product.range.max) {
          throw new ShroudError(
            "INVALID_SELECTION",
            `Value ${sel.value} is outside allowed range (${product.range.min} - ${product.range.max})`
          );
        }
      }

      return this.convertFx(sel.value, String(sel.value), product.currency);
    }

    // 3. Fallback: first package if available
    if (product.packages && product.packages.length > 0) {
      const pkg = product.packages[0];
      if (pkg.priceCents !== undefined && pkg.priceCents > 0) {
        return {
          priceCents: pkg.priceCents,
          faceValue: pkg.value,
          faceCurrency: product.currency,
          source: "bitrefill"
        };
      }
      const numVal = parseFloat(pkg.value);
      return this.convertFx(numVal, pkg.value, product.currency);
    }

    throw new ShroudError(
      "INVALID_SELECTION",
      `No package or value selected for product "${product.name}"`
    );
  }

  /**
   * Bitrefill's package `amount` is denominated in the product's own currency
   * (e.g. 500 for a ₹500 Swiggy card), not USD. Treating it as USD priced a
   * ₹500 card at $500 and made the policy DENY it.
   */
  private packageAmountToUsdCents(amount: unknown, currency: string): number | undefined {
    const n = Number(amount);
    if (!amount || !Number.isFinite(n) || n <= 0) return undefined;
    if (currency === "USD") return Math.round(n * 100);
    const rate = this.fxUsdPer[currency];
    if (!rate || rate <= 0) return undefined;
    return Math.max(1, Math.round(n * rate * 100));
  }

  private convertFx(numericFace: number, faceValue: string, faceCurrency: string): PriceInfo {
    const upperCurrency = faceCurrency.toUpperCase();
    if (upperCurrency === "USD") {
      return {
        priceCents: Math.round(numericFace * 100),
        faceValue,
        faceCurrency,
        source: "bitrefill"
      };
    }

    const rate = this.fxUsdPer[upperCurrency];
    if (!rate || rate <= 0) {
      throw new ShroudError(
        "PRICE_UNAVAILABLE",
        `No USD exchange rate configured for currency "${faceCurrency}"`
      );
    }

    const usd = numericFace * rate;
    return {
      priceCents: Math.max(1, Math.round(usd * 100)),
      faceValue,
      faceCurrency,
      source: "fx"
    };
  }

  async createCryptoInvoice(
    sel: Selection,
    paymentMethod: string,
    refundAddress: string
  ): Promise<CryptoInvoice> {
    const item: Record<string, unknown> = {
      product_id: sel.productId,
      quantity: 1
    };
    if (sel.packageId) {
      item.package_id = sel.packageId;
    } else if (sel.value !== undefined) {
      item.value = sel.value;
    }

    const body = {
      products: [item],
      payment_method: paymentMethod,
      refund_address: refundAddress
    };

    const res = await this.request<any>({
      method: "POST",
      path: "/invoices",
      body
    });

    const data = res.data ?? res;
    if (!data.id || !data.payment?.address) {
      throw new ShroudError("MERCHANT_ERROR", "Bitrefill invoice response missing payment details");
    }

    // Parse decimal price into base units (USDC has 6 decimal places = 10^6)
    const priceStr = String(data.payment.price);
    const priceFloat = parseFloat(priceStr);
    const payAmountBase = BigInt(Math.round(priceFloat * 1_000_000));
    const priceCents = Math.round(priceFloat * 100);

    return {
      invoiceId: data.id,
      payAddress: data.payment.address,
      payAmountBase,
      payCurrency: data.payment.currency || paymentMethod,
      priceCents
    };
  }

  async placeTestOrder(
    sel: Selection,
    productType: ProductType
  ): Promise<{ invoiceId: string; orderId: string }> {
    const testProductId = productType === "refill" ? "test-phone-refill" : "test-gift-card-code";

    // Balance guard: only test products may use payment_method: "balance"
    if (!testProductId.startsWith("test-")) {
      throw new ShroudError(
        "FORBIDDEN_BALANCE_PAYMENT",
        "Balance payments are strictly limited to test products"
      );
    }

    const body = {
      products: [
        {
          product_id: testProductId,
          value: 10,
          quantity: 1
        }
      ],
      payment_method: "balance",
      auto_pay: true
    };

    const res = await this.request<any>({
      method: "POST",
      path: "/invoices",
      body
    });

    const data = res.data ?? res;
    const invoiceId = data.id;
    const orderId =
      data.order_ids?.[0] || data.order_id || (data.orders?.[0]?.id ?? `ord_${invoiceId}`);

    return { invoiceId, orderId };
  }

  async placeBalanceOrder(sel: Selection): Promise<{ invoiceId: string; orderId: string }> {
    // Real product, real money (store credit). Callers enforce the per-order and total caps
    // (DemoSwapExecutor) on top of the policy engine; this only builds the exact selection.
    const item: Record<string, unknown> = { product_id: sel.productId, quantity: 1 };
    if (sel.packageId) item.package_id = sel.packageId;
    else if (sel.value !== undefined) item.value = sel.value;
    else throw new ShroudError("INVALID_SELECTION", "Balance order needs a package or value");

    const res = await this.request<any>({
      method: "POST",
      path: "/invoices",
      body: { products: [item], payment_method: "balance", auto_pay: true }
    });

    const data = res.data ?? res;
    const invoiceId = data.id;
    if (!invoiceId) {
      throw new ShroudError("MERCHANT_ERROR", "Bitrefill balance order returned no invoice id");
    }
    let orderId: string | undefined =
      data.order_ids?.[0] || data.order_id || data.orders?.[0]?.id;

    // The invoice now exists and may already be paid: from here on, never throw, or a
    // retry would place (and pay for) a second order. A missing order id is resolved later
    // by the worker from this invoice id.
    for (let i = 0; !orderId && i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        orderId = (await this.getInvoice(invoiceId)).orderIds[0];
      } catch {
        // keep the invoice id; the worker polls it
      }
    }
    return { invoiceId, orderId: orderId ?? "" };
  }

  async getInvoice(id: string): Promise<{ status: InvoiceStatus; orderIds: string[] }> {
    const res = await this.request<any>({
      method: "GET",
      path: `/invoices/${encodeURIComponent(id)}`
    });

    const data = res.data ?? res;
    const rawStatus = String(data.status || "").toLowerCase();

    let status: InvoiceStatus = "pending";
    if (rawStatus === "paid") status = "paid";
    else if (rawStatus === "completed" || rawStatus === "delivered") status = "completed";
    else if (rawStatus === "expired") status = "expired";
    else if (/denied|blocked|failed|rejected/.test(rawStatus)) status = "rejected";

    const orderIds: string[] =
      data.order_ids ??
      (data.order_id
        ? [data.order_id]
        : Array.isArray(data.orders)
          ? data.orders.map((o: any) => o?.id).filter(Boolean)
          : []);

    return { status, orderIds };
  }

  async getOrder(id: string): Promise<{
    status: OrderStatus;
    redemption: {
      code?: string;
      link?: string;
      instructions?: string;
    };
  }> {
    const res = await this.request<any>({
      method: "GET",
      path: `/orders/${encodeURIComponent(id)}`
    });

    const data = res.data ?? res;
    const rawStatus = String(data.status || "").toLowerCase();

    let status: OrderStatus = "created";
    if (rawStatus === "delivered" || rawStatus === "completed") status = "delivered";
    else if (rawStatus === "failed" || rawStatus === "rejected") status = "failed";
    else if (rawStatus === "canceled") status = "canceled";

    // Extract redemption info
    const cardInfo = data.cards?.[0] ?? data.redemption_info ?? {};
    const code = cardInfo.pin || cardInfo.code || cardInfo.number || data.code;
    const link = cardInfo.link || cardInfo.url || data.redemption_link;
    const instructions = cardInfo.instructions || data.instructions || data.termsAndConditions;

    return {
      status,
      redemption: {
        code: code ? String(code) : undefined,
        link: link ? String(link) : undefined,
        instructions: instructions ? String(instructions) : undefined
      }
    };
  }
}

