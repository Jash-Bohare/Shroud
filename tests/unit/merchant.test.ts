import { describe, expect, it } from "vitest";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { BitrefillMerchantAdapter } from "../../src/merchant/bitrefill.js";

describe("MockMerchantAdapter", () => {
  const merchant = new MockMerchantAdapter();

  it("searches products with type and country filter", async () => {
    const esimResults = await merchant.search("esim", { type: "esim" });
    expect(esimResults.length).toBeGreaterThan(0);
    expect(esimResults[0].type).toBe("esim");

    const indiaResults = await merchant.search("swiggy", { country: "IN" });
    expect(indiaResults.length).toBe(1);
    expect(indiaResults[0].id).toBe("swiggy-in");
  });

  it("retrieves product details by id", async () => {
    const product = await merchant.getProduct("swiggy-in");
    expect(product.id).toBe("swiggy-in");
    expect(product.currency).toBe("INR");
    expect(product.packages?.length).toBe(3);
  });

  it("calculates price for package and range", async () => {
    const pkgPrice = await merchant.price({
      productId: "swiggy-in",
      packageId: "swiggy-500"
    });
    expect(pkgPrice.priceCents).toBe(600);
    expect(pkgPrice.faceValue).toBe("500");

    const rangePrice = await merchant.price({
      productId: "amazon-in",
      value: 500
    });
    expect(rangePrice.priceCents).toBe(600);
  });

  it("places test orders and delivers codes", async () => {
    const order = await merchant.placeTestOrder(
      { productId: "test-gift-card-code" },
      "giftcard"
    );
    expect(order.orderId).toBeDefined();

    const orderDetail = await merchant.getOrder(order.orderId);
    expect(orderDetail.status).toBe("delivered");
    expect(orderDetail.redemption.code).toMatch(/^MOCK-/);
  });
});


describe("BitrefillMerchantAdapter pricing (live API shape)", () => {
  // Shape recorded from GET /v2/products/{id} on 4 Nov 2026: `amount` is in the product currency.
  const fixtures: Record<string, any> = {
    "swiggy-money-india": {
      id: "swiggy-money-india",
      name: "Swiggy Money India",
      country_code: "IN",
      currency: "INR",
      categories: ["food", "food-delivery"],
      in_stock: true,
      packages: [
        { id: "swiggy-money-india<&>500", value: "500", price: 7040, amount: 500 },
        { id: "swiggy-money-india<&>1000", value: "1000", price: 14078, amount: 1000 }
      ]
    },
    "bitrefill-esim-india": {
      id: "bitrefill-esim-india",
      name: "Bitrefill eSIM India",
      country_code: "IN",
      currency: "USD",
      categories: ["esim"],
      in_stock: true,
      packages: [{ id: "bitrefill-esim-india<&>1GB, 7 Days", value: "1GB, 7 Days", price: 4986, amount: 2.59 }]
    }
  };

  function makeAdapter() {
    const adapter = new BitrefillMerchantAdapter({ apiKey: "test-key" });
    (adapter as any).request = async ({ path }: { path: string }) => {
      const id = decodeURIComponent(path.replace("/products/", ""));
      return { data: fixtures[id] };
    };
    return adapter;
  }

  it("converts INR package amounts to USD cents (₹500 Swiggy is ~$6, not $500)", async () => {
    const priceInfo = await makeAdapter().price({
      productId: "swiggy-money-india",
      packageId: "swiggy-money-india<&>500"
    });
    expect(priceInfo.priceCents).toBeLessThan(1000);
    expect(priceInfo.priceCents).toBeGreaterThan(300);
    expect(priceInfo.faceCurrency).toBe("INR");
  });

  it("keeps USD package amounts as-is", async () => {
    const priceInfo = await makeAdapter().price({
      productId: "bitrefill-esim-india",
      packageId: "bitrefill-esim-india<&>1GB, 7 Days"
    });
    expect(priceInfo.priceCents).toBe(259);
  });

  it("does not prefix plan names with a currency symbol", async () => {
    const p = await makeAdapter().getProduct("bitrefill-esim-india");
    expect(p.denominations).toBe("1GB, 7 Days");
    const s = await makeAdapter().getProduct("swiggy-money-india");
    expect(s.denominations).toBe("₹500 | ₹1000");
  });
});
