import { ProductType } from "../shared/types.js";

export type InvoiceStatus = "pending" | "paid" | "completed" | "expired" | "rejected";
export type OrderStatus = "created" | "delivered" | "failed" | "canceled";

export interface ProductSummary {
  id: string;
  name: string;
  type: ProductType;
  country: string | null;
  currency: string;
  inStock: boolean;
  denominations: string; // e.g. "₹100–₹10,000" or "₹500, ₹1000"
}

export interface PackageDetail {
  id: string;
  value: string;
  priceCents?: number;
}

export interface ProductDetail extends ProductSummary {
  packages?: PackageDetail[];
  range?: {
    min: number;
    max: number;
    step: number;
  };
  rawType: string; // Bitrefill's original type string
}

export interface Selection {
  productId: string;
  packageId?: string;
  value?: number;
}

export interface PriceInfo {
  priceCents: number;
  faceValue: string;
  faceCurrency: string;
  source: "bitrefill" | "fx";
}

export interface CryptoInvoice {
  invoiceId: string;
  payAddress: string;
  payAmountBase: bigint;
  payCurrency: string;
  priceCents: number;
}

export interface MerchantAdapter {
  search(
    q: string,
    opts?: { country?: string; type?: ProductType; limit?: number }
  ): Promise<ProductSummary[]>;

  getProduct(id: string): Promise<ProductDetail>;

  price(sel: Selection): Promise<PriceInfo>;

  createCryptoInvoice(
    sel: Selection,
    paymentMethod: string,
    refundAddress: string
  ): Promise<CryptoInvoice>;

  placeTestOrder(
    sel: Selection,
    productType: ProductType
  ): Promise<{ invoiceId: string; orderId: string }>;

  /** Orders the real product, paid from the account's Bitrefill balance / store credit. */
  placeBalanceOrder(sel: Selection): Promise<{ invoiceId: string; orderId: string }>;

  getInvoice(id: string): Promise<{ status: InvoiceStatus; orderIds: string[] }>;

  getOrder(id: string): Promise<{
    status: OrderStatus;
    redemption: {
      code?: string;
      link?: string;
      instructions?: string;
    };
  }>;
}

