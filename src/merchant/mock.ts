import { ShroudError } from "../shared/errors.js";
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

const MOCK_PRODUCTS: ProductDetail[] = [
  {
    id: "india-esim",
    name: "Airtel India eSIM (3GB - 30 Days)",
    type: "esim",
    country: "IN",
    currency: "USD",
    inStock: true,
    denominations: "$3.50, $7.00, $15.00",
    packages: [
      { id: "esim-1gb", value: "1GB", priceCents: 350 },
      { id: "esim-3gb", value: "3GB", priceCents: 700 },
      { id: "esim-10gb", value: "10GB", priceCents: 1500 }
    ],
    rawType: "esim"
  },
  {
    id: "swiggy-in",
    name: "Swiggy Food & Instamart Voucher",
    type: "giftcard",
    country: "IN",
    currency: "INR",
    inStock: true,
    denominations: "₹250, ₹500, ₹1000",
    packages: [
      { id: "swiggy-250", value: "250", priceCents: 300 },
      { id: "swiggy-500", value: "500", priceCents: 600 },
      { id: "swiggy-1000", value: "1000", priceCents: 1200 }
    ],
    rawType: "giftcard"
  },
  {
    id: "zomato-in",
    name: "Zomato Dining & Delivery Gift Card",
    type: "giftcard",
    country: "IN",
    currency: "INR",
    inStock: true,
    denominations: "₹250, ₹500, ₹1000",
    packages: [
      { id: "zomato-250", value: "250", priceCents: 300 },
      { id: "zomato-500", value: "500", priceCents: 600 },
      { id: "zomato-1000", value: "1000", priceCents: 1200 }
    ],
    rawType: "giftcard"
  },
  {
    id: "amazon-in",
    name: "Amazon Pay Gift Card India",
    type: "giftcard",
    country: "IN",
    currency: "INR",
    inStock: true,
    denominations: "₹100–₹10,000",
    range: { min: 100, max: 10000, step: 50 },
    rawType: "giftcard"
  },
  {
    id: "airtel-in",
    name: "Airtel Prepaid Mobile Top-up",
    type: "refill",
    country: "IN",
    currency: "INR",
    inStock: true,
    denominations: "₹199, ₹299, ₹666",
    packages: [
      { id: "airtel-199", value: "199", priceCents: 240 },
      { id: "airtel-299", value: "299", priceCents: 360 },
      { id: "airtel-666", value: "666", priceCents: 800 }
    ],
    rawType: "refill"
  },
  {
    id: "uber-in",
    name: "Uber Rides Voucher India",
    type: "giftcard",
    country: "IN",
    currency: "INR",
    inStock: true,
    denominations: "₹250, ₹500",
    packages: [
      { id: "uber-250", value: "250", priceCents: 300 },
      { id: "uber-500", value: "500", priceCents: 600 }
    ],
    rawType: "giftcard"
  },
  {
    id: "steam-usd",
    name: "Steam Wallet Card",
    type: "giftcard",
    country: "US",
    currency: "USD",
    inStock: true,
    denominations: "$10, $20, $50",
    packages: [
      { id: "steam-10", value: "10", priceCents: 1000 },
      { id: "steam-20", value: "20", priceCents: 2000 },
      { id: "steam-50", value: "50", priceCents: 5000 }
    ],
    rawType: "giftcard"
  },
  {
    id: "netflix-in",
    name: "Netflix Subscription Card",
    type: "giftcard",
    country: "IN",
    currency: "INR",
    inStock: true,
    denominations: "₹500, ₹1000",
    packages: [
      { id: "netflix-500", value: "500", priceCents: 600 },
      { id: "netflix-1000", value: "1000", priceCents: 1200 }
    ],
    rawType: "giftcard"
  },
  {
    id: "test-gift-card-code",
    name: "Bitrefill Test Gift Card",
    type: "giftcard",
    country: "US",
    currency: "USD",
    inStock: true,
    denominations: "$5, $10, $20",
    packages: [
      { id: "test-5", value: "5", priceCents: 500 },
      { id: "test-10", value: "10", priceCents: 1000 }
    ],
    range: { min: 5, max: 100, step: 5 },
    rawType: "giftcard"
  }
];

export class MockMerchantAdapter implements MerchantAdapter {
  private readonly products: ProductDetail[] = MOCK_PRODUCTS;
  private readonly orders = new Map<string, { status: OrderStatus; code: string }>();

  async search(
    q: string,
    opts?: { country?: string; type?: ProductType; limit?: number }
  ): Promise<ProductSummary[]> {
    const query = q.toLowerCase();
    let res = this.products.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query) ||
        p.type.toLowerCase().includes(query)
    );

    if (opts?.type) {
      res = res.filter((p) => p.type === opts.type);
    }
    if (opts?.country) {
      res = res.filter((p) => !p.country || p.country.toUpperCase() === opts.country!.toUpperCase());
    }
    if (opts?.limit) {
      res = res.slice(0, opts.limit);
    }

    return res.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      country: p.country,
      currency: p.currency,
      inStock: p.inStock,
      denominations: p.denominations
    }));
  }

  async getProduct(id: string): Promise<ProductDetail> {
    const p = this.products.find((prod) => prod.id === id);
    if (!p) {
      throw new ShroudError("PRODUCT_NOT_FOUND", `Mock product "${id}" not found`);
    }
    return p;
  }

  async price(sel: Selection): Promise<PriceInfo> {
    const product = await this.getProduct(sel.productId);

    if (sel.packageId) {
      const pkg = product.packages?.find((p) => p.id === sel.packageId);
      if (!pkg) {
        throw new ShroudError(
          "INVALID_SELECTION",
          `Package "${sel.packageId}" not found for product "${product.name}"`
        );
      }
      return {
        priceCents: pkg.priceCents || 500,
        faceValue: pkg.value,
        faceCurrency: product.currency,
        source: "bitrefill"
      };
    }

    if (sel.value !== undefined) {
      if (product.range) {
        if (sel.value < product.range.min || sel.value > product.range.max) {
          throw new ShroudError(
            "INVALID_SELECTION",
            `Value ${sel.value} is outside range (${product.range.min} - ${product.range.max})`
          );
        }
      }
      const cents = Math.round(sel.value * (product.currency === "INR" ? 1.2 : 100));
      return {
        priceCents: cents,
        faceValue: String(sel.value),
        faceCurrency: product.currency,
        source: product.currency === "USD" ? "bitrefill" : "fx"
      };
    }

    if (product.packages && product.packages.length > 0) {
      const pkg = product.packages[0];
      return {
        priceCents: pkg.priceCents || 500,
        faceValue: pkg.value,
        faceCurrency: product.currency,
        source: "bitrefill"
      };
    }

    throw new ShroudError("INVALID_SELECTION", "No package or value provided");
  }

  async createCryptoInvoice(
    sel: Selection,
    _paymentMethod: string,
    _refundAddress: string
  ): Promise<CryptoInvoice> {
    const priceInfo = await this.price(sel);
    const invoiceId = `inv_mock_${Date.now()}`;
    return {
      invoiceId,
      payAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payAmountBase: BigInt(priceInfo.priceCents * 10_000), // USDC 6 decimals
      payCurrency: "usdc_base",
      priceCents: priceInfo.priceCents
    };
  }

  async placeTestOrder(
    _sel: Selection,
    _productType: ProductType
  ): Promise<{ invoiceId: string; orderId: string }> {
    const ts = Date.now();
    const invoiceId = `inv_test_${ts}`;
    const orderId = `ord_test_${ts}`;
    const randCode = `MOCK-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;

    this.orders.set(orderId, { status: "delivered", code: randCode });
    return { invoiceId, orderId };
  }

  async placeBalanceOrder(sel: Selection): Promise<{ invoiceId: string; orderId: string }> {
    await this.price(sel); // validates the selection like the real adapter
    const ts = Date.now();
    const orderId = `ord_bal_${ts}`;
    this.orders.set(orderId, { status: "delivered", code: `MOCK-REAL-${ts % 10000}` });
    return { invoiceId: `inv_bal_${ts}`, orderId };
  }

  async getInvoice(id: string): Promise<{ status: InvoiceStatus; orderIds: string[] }> {
    return { status: "completed", orderIds: [`ord_${id}`] };
  }

  async getOrder(id: string): Promise<{
    status: OrderStatus;
    redemption: {
      code?: string;
      link?: string;
      instructions?: string;
    };
  }> {
    const existing = this.orders.get(id);
    const code = existing?.code ?? `MOCK-9874-1234`;
    return {
      status: "delivered",
      redemption: {
        code,
        instructions: "Redeem online at merchant checkout"
      }
    };
  }
}

