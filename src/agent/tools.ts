import { z } from "zod";
import { MerchantAdapter } from "../merchant/types.js";
import { PurchaseService } from "../router/purchase-service.js";
import { ToolDef } from "./llm.js";
import { sanitizeToolOutput } from "./sanitize.js";

// 1. Zod Input Schemas
export const searchProductsSchema = z.object({
  query: z.string().min(2).max(60),
  country: z.string().length(2).toUpperCase().optional(),
  type: z.enum(["giftcard", "esim", "refill"]).optional()
});

/** Models often send `null` for optional fields they don't use; treat that as absent. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema.optional());

export const getProductSchema = z.object({
  product_id: z.string().min(1)
});

export const getQuoteSchema = z
  .object({
    product_id: z.string().min(1),
    package_id: optional(z.string().min(1)),
    value: optional(z.number().positive())
  })
  .refine(
    (data) => (data.package_id !== undefined) !== (data.value !== undefined),
    {
      message: "Must provide exactly one of package_id or value"
    }
  );

export const requestPurchaseSchema = z
  .object({
    product_id: z.string().min(1),
    package_id: optional(z.string().min(1)),
    value: optional(z.number().positive()),
    reason: z.string().min(3).max(120)
  })
  .refine(
    (data) => (data.package_id !== undefined) !== (data.value !== undefined),
    {
      message: "Must provide exactly one of package_id or value"
    }
  );

export const getBudgetSchema = z.object({});

export const listRecentPurchasesSchema = z.object({
  limit: z.number().int().min(1).max(10).optional().default(5)
});

export const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  search_products: searchProductsSchema,
  get_product: getProductSchema,
  get_quote: getQuoteSchema,
  request_purchase: requestPurchaseSchema,
  get_budget: getBudgetSchema,
  list_recent_purchases: listRecentPurchasesSchema
};

// 2. OpenAI Function Tool Definitions
export const AGENT_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search the Bitrefill catalog for gift cards, eSIMs and mobile refills. Use a short query like 'esim' or 'swiggy' plus the country code. Results only preview the first few denominations: call get_product to see every package instead of searching again.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword, brand, or service name (e.g. Swiggy, Amazon, Airtel, eSIM)"
          },
          country: {
            type: "string",
            description: "Two-letter ISO country code (e.g. IN, US, GB)"
          },
          type: {
            type: "string",
            enum: ["giftcard", "esim", "refill"],
            description: "Category of product"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_product",
      description:
        "Get detailed denominations, packages, or price range for a specific product ID",
      parameters: {
        type: "object",
        properties: {
          product_id: {
            type: "string",
            description: "The product identifier from search results"
          }
        },
        required: ["product_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_quote",
      description:
        "Check the authoritative price and evaluate if the owner's rules allow this purchase before buying",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string", description: "The product ID" },
          package_id: {
            type: ["string", "null"],
            description:
              "Package ID exactly as returned by get_product (e.g. \"swiggy-money-india<&>500\"). Use this OR value, not both."
          },
          value: {
            type: ["number", "null"],
            description: "Amount for open-range products (no packages). Use this OR package_id, not both."
          }
        },
        required: ["product_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_purchase",
      description:
        "Submit a purchase request to the vault. Evaluated by the policy engine; auto-approves or requests owner approval.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string", description: "The product ID to buy" },
          package_id: {
            type: ["string", "null"],
            description:
              "Package ID exactly as returned by get_product. Use this OR value, not both."
          },
          value: {
            type: ["number", "null"],
            description: "Amount for open-range products (no packages). Use this OR package_id, not both."
          },
          reason: {
            type: "string",
            description:
              "A brief one-line reason explaining the purchase purpose (e.g. Dinner on Friday)"
          }
        },
        required: ["product_id", "reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_budget",
      description:
        "Check the remaining daily and monthly spend limits, auto-approve threshold, and vault spendable ZEC balance",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_recent_purchases",
      description:
        "List recent purchases made by the vault and their current delivery statuses",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of purchases to return (1-10, default 5)"
          }
        }
      }
    }
  }
];

export interface ToolContext {
  merchant: MerchantAdapter;
  purchaseService: PurchaseService;
  createdPurchaseIds: string[];
}

export class ToolExecutor {
  private purchaseCount = 0;
  private purchaseBlocked = false;
  private readonly maxPurchasesPerMessage = 2;

  constructor(private readonly ctx: ToolContext) {}

  async execute(name: string, rawArgs: string): Promise<unknown> {
    let parsedArgs: any;
    try {
      parsedArgs = JSON.parse(rawArgs || "{}");
    } catch {
      return { error: "Malformed JSON arguments in tool call" };
    }

    const schema = TOOL_SCHEMAS[name];
    if (!schema) {
      return { error: `Unknown tool: "${name}"` };
    }

    const validation = schema.safeParse(parsedArgs);
    if (!validation.success) {
      return {
        error: `Invalid arguments for ${name}: ${validation.error.issues.map((i) => i.message).join("; ")}`
      };
    }

    const args = validation.data;

    try {
      switch (name) {
        case "search_products": {
          const results = await this.ctx.merchant.search(args.query, {
            country: args.country,
            type: args.type,
            limit: 5
          });
          return sanitizeToolOutput({
            results: results.slice(0, 5).map((p) => ({
              product_id: p.id,
              name: p.name,
              type: p.type,
              country: p.country,
              currency: p.currency,
              denominations: p.denominations,
              in_stock: p.inStock
            }))
          });
        }

        case "get_product": {
          const p = await this.ctx.merchant.getProduct(args.product_id);
          return sanitizeToolOutput({
            product_id: p.id,
            name: p.name,
            type: p.type,
            country: p.country,
            currency: p.currency,
            packages: p.packages?.map((pkg) => ({
              package_id: pkg.id,
              value: pkg.value
            })),
            range: p.range
          });
        }

        case "get_quote": {
          const q = await this.ctx.purchaseService.quote({
            productId: args.product_id,
            packageId: args.package_id,
            value: args.value
          });
          return sanitizeToolOutput({
            face: `${q.faceCurrency} ${q.faceValue}`,
            usd: q.priceUsd,
            zec: q.quotedZec,
            policy: q.policy?.decision || "ALLOW",
            // Only the reasons that produce the decision: on a DENY, an "needs approval" (ASK)
            // reason is noise and led the model to say the auto-approve limit denied it.
            reasons:
              q.policy?.reasons
                .filter((r) => q.policy?.decision !== "DENY" || r.outcome === "DENY")
                .map((r) => r.message) || []
          });
        }

        case "request_purchase": {
          if (this.purchaseCount >= this.maxPurchasesPerMessage) {
            return {
              error: `Purchase limit reached: maximum ${this.maxPurchasesPerMessage} purchase requests per message.`
            };
          }

          // After a blocked purchase the agent must not pick a substitute by itself (it once
          // bought a ₹100 card after ₹500 was capped). Only the owner chooses an alternative.
          if (this.purchaseBlocked) {
            return {
              error:
                "A purchase in this message was just blocked. Do not request a different product or amount. " +
                "Tell the owner why it was blocked, list the options that would fit, and wait for them to choose."
            };
          }

          this.purchaseCount++;
          let purchase;
          try {
            purchase = await this.ctx.purchaseService.request(
              {
                productId: args.product_id,
                packageId: args.package_id,
                value: args.value
              },
              args.reason,
              "agent"
            );
          } catch (err) {
            this.purchaseBlocked = true;
            throw err;
          }
          if (purchase.status === "DENIED") this.purchaseBlocked = true;

          this.ctx.createdPurchaseIds.push(purchase.id);

          return sanitizeToolOutput({
            purchase_id: purchase.id,
            status: purchase.status,
            reasons: purchase.policyReasons,
            message:
              purchase.status === "APPROVED"
                ? "Purchase approved and queued for payment."
                : purchase.status === "AWAITING_APPROVAL"
                  ? "Purchase requires human owner approval in Telegram."
                  : "Purchase was denied by your spending policy rules."
          });
        }

        case "get_budget": {
          const b = await this.ctx.purchaseService.budget();
          return sanitizeToolOutput({
            left_today: `$${(b.leftTodayCents / 100).toFixed(2)}`,
            left_month: `$${(b.leftMonthCents / 100).toFixed(2)}`,
            purchases_left_today: b.purchasesLeftToday,
            vault_balance_zec: b.vaultSpendableZec,
            auto_approve_up_to: `$${(b.autoApproveUpToCents / 100).toFixed(2)}`,
            paused: b.paused
          });
        }

        case "list_recent_purchases": {
          const list = this.ctx.purchaseService.list({ limit: args.limit });
          return sanitizeToolOutput({
            purchases: list.map((p) => ({
              purchase_id: p.id,
              product: p.productName,
              usd: p.priceUsd,
              status: p.status,
              when: p.createdAt
            }))
          });
        }

        default:
          return { error: `Unhandled tool: "${name}"` };
      }
    } catch (err: any) {
      return { error: err.message || "Tool execution failed" };
    }
  }
}

