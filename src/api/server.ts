import cors from "cors";
import Database from "better-sqlite3";
import express, { Express, Request, Response } from "express";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { MerchantAdapter } from "../merchant/types.js";
import { PolicyStore } from "../policy/store.js";
import { PriceSource } from "../pricing/types.js";
import { eventBus } from "../router/events.js";
import { PurchaseService } from "../router/purchase-service.js";
import { ShroudError } from "../shared/errors.js";
import { Actor, EventView, PurchaseView, Status } from "../shared/types.js";
import { VaultService } from "../zcash/vault.js";
import { createAuthMiddleware, errorHandler } from "./middleware.js";

const selectionSchema = z
  .object({
    productId: z.string().min(1).max(200),
    packageId: z.string().min(1).max(200).optional(),
    value: z.number().positive().optional()
  })
  .strict();

const purchaseBodySchema = selectionSchema.extend({ reason: z.string().max(200).optional() }).strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ShroudError(
      "VALIDATION_ERROR",
      `Invalid request body: ${r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`
    );
  }
  return r.data;
}

export interface ApiServerDeps {
  db?: Database.Database;
  vault: VaultService;
  purchaseService: PurchaseService;
  policyStore: PolicyStore;
  merchant?: MerchantAdapter;
  pricing?: PriceSource;
  dashboardToken?: string;
  /** Present in demo mode: how the desk fulfils orders and the store-credit budget left. */
  deskBudget?: () => {
    orderMode: "test" | "balance";
    maxOrderCents: number;
    maxTotalCents: number;
    spentCents: number;
    leftCents: number;
  };
}

export function createApiApp(deps: ApiServerDeps): Express {
  const env = getEnv();
  const token = deps.dashboardToken || env.DASHBOARD_TOKEN;

  const app = express();
  // Only the dashboard origin may call the API from a browser: a wildcard
  // would let any web page the owner visits probe the local API.
  app.use(cors({ origin: env.DASHBOARD_ORIGIN }));
  app.use(express.json());

  // 1. Health check (public)
  // Real vault check (zcash-devtool reachable), cached so a public health poll can't spawn
  // a devtool process per request.
  let vaultHealth = { ok: false, at: 0 };
  const getVaultOk = async (): Promise<boolean> => {
    if (Date.now() - vaultHealth.at > 60_000) {
      const h = await deps.vault.health().catch(() => ({ ok: false }));
      vaultHealth = { ok: h.ok, at: Date.now() };
    }
    return vaultHealth.ok;
  };

  app.get(["/health", "/api/health"], async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      mode: env.SHROUD_MODE,
      network: env.ZCASH_NETWORK,
      version: "0.1.0",
      vault: { ok: typeof deps.vault.health === "function" ? await getVaultOk() : false },
      fulfilment:
        env.SHROUD_MODE === "live"
          ? "1click-swap"
          : env.BITREFILL_ORDER_MODE === "balance"
            ? "bitrefill-store-credit"
            : "bitrefill-test-product",
      llm: {
        provider: env.LLM_BASE_URL.includes("groq") ? "groq" : "openai",
        model: env.LLM_MODEL
      },
      merchant: env.BITREFILL_MODE
    });
  });

  // 2. Authentication guard for remaining endpoints
  app.use(createAuthMiddleware(token));

  // 3. SSE Stream for real-time dashboard updates
  app.get("/api/events/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    res.write(": connected\n\n");

    const onPurchase = (view: PurchaseView) => {
      try {
        res.write(`event: purchase\ndata: ${JSON.stringify(view)}\n\n`);
      } catch {}
    };

    const onPolicy = (policy: unknown) => {
      try {
        res.write(`event: policy\ndata: ${JSON.stringify(policy)}\n\n`);
      } catch {}
    };

    eventBus.on("purchase", onPurchase);
    eventBus.on("policy", onPolicy);

    const timer = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {}
    }, 15000);

    req.on("close", () => {
      clearInterval(timer);
      eventBus.off("purchase", onPurchase);
      eventBus.off("policy", onPolicy);
    });
  });

  // 4. Wallet endpoints
  app.get("/api/wallet", async (_req: Request, res: Response, next) => {
    try {
      const fundingAddress = await deps.vault.getFundingAddress();
      let receiptsAddress = "";
      try {
        receiptsAddress = await deps.vault.getReceiptsAddress();
      } catch {
        receiptsAddress = "";
      }

      const balance = await deps.vault.getBalance("vault");
      const spendableZec = (Number(balance.spendableZats) / 100_000_000).toFixed(4);

      // Only show a USD value from a live price; never a made-up fallback rate.
      let usdEstimate: string | null = null;
      if (deps.pricing) {
        try {
          const q = await deps.pricing.quoteUsdCentsToZats(10000);
          if (q.source !== "fixed") {
            usdEstimate = `$${((Number(balance.spendableZats) / 100_000_000) * q.usdPerZec).toFixed(2)}`;
          }
        } catch {}
      }

      res.json({
        fundingAddress,
        balance: {
          spendableZats: balance.spendableZats.toString(),
          pendingZats: balance.pendingZats.toString(),
          totalZats: balance.totalZats.toString(),
          spendableZec,
          usdEstimate
        },
        receiptsAddress
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/wallet/sync", async (_req: Request, res: Response, next) => {
    try {
      const start = Date.now();
      await deps.vault.sync();
      res.json({ ok: true, durationMs: Date.now() - start });
    } catch (err) {
      next(err);
    }
  });

  // 5. Policy endpoints
  app.get("/api/policy", (_req: Request, res: Response) => {
    res.json(deps.policyStore.get());
  });

  app.put("/api/policy", (req: Request, res: Response, next) => {
    try {
      const updated = deps.policyStore.update(req.body, "owner:dashboard");
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/policy/pause", (_req: Request, res: Response, next) => {
    try {
      const updated = deps.policyStore.setPaused(true, "owner:dashboard");
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/policy/resume", (_req: Request, res: Response, next) => {
    try {
      const updated = deps.policyStore.setPaused(false, "owner:dashboard");
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // 6. Budget
  app.get("/api/budget", async (_req: Request, res: Response, next) => {
    try {
      const b = await deps.purchaseService.budget();
      res.json({ ...b, realOrders: deps.deskBudget ? deps.deskBudget() : null });
    } catch (err) {
      next(err);
    }
  });

  // 7. Merchant catalog & quotes
  app.get("/api/products/search", async (req: Request, res: Response, next) => {
    try {
      if (!deps.merchant) {
        res.json({ results: [] });
        return;
      }
      const q = (req.query.q as string) || "";
      const country = req.query.country as string | undefined;
      const type = req.query.type as any;
      const results = await deps.merchant.search(q, { country, type });
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/products/:id", async (req: Request, res: Response, next) => {
    try {
      if (!deps.merchant) {
        throw new ShroudError("PRODUCT_NOT_FOUND", "Merchant adapter unavailable");
      }
      const product = await deps.merchant.getProduct(req.params.id);
      res.json(product);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/quotes", async (req: Request, res: Response, next) => {
    try {
      const quote = await deps.purchaseService.quote(parseBody(selectionSchema, req.body));
      res.json(quote);
    } catch (err) {
      next(err);
    }
  });

  // 8. Purchases
  app.post("/api/purchases", async (req: Request, res: Response, next) => {
    try {
      const { reason, ...selection } = parseBody(purchaseBodySchema, req.body);
      const purchase = await deps.purchaseService.request(
        selection,
        reason || "Dashboard purchase",
        "dashboard"
      );
      res.json(purchase);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/purchases", (req: Request, res: Response, next) => {
    try {
      const status = req.query.status as any;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;
      const items = deps.purchaseService.list({ status, limit, offset });
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/purchases/:id", (req: Request, res: Response, next) => {
    try {
      const item = deps.purchaseService.get(req.params.id);
      let events: EventView[] = [];
      if (deps.db) {
        const rows = deps.db
          .prepare("SELECT * FROM events WHERE purchase_id = ? ORDER BY id ASC")
          .all(req.params.id) as Array<{
            id: number | bigint;
            purchase_id: string | null;
            type: string;
            from_status: Status | null;
            to_status: Status | null;
            actor: Actor;
            data: string;
            simulated: number | bigint;
            created_at: string;
          }>;
        events = rows.map((e) => ({
          id: Number(e.id),
          purchaseId: e.purchase_id,
          type: e.type,
          fromStatus: e.from_status,
          toStatus: e.to_status,
          actor: e.actor,
          data: (() => {
            try {
              return JSON.parse(e.data);
            } catch {
              return {};
            }
          })(),
          simulated: Boolean(e.simulated),
          createdAt: e.created_at
        }));
      }
      res.json({ ...item, events });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/purchases/:id/approve", (req: Request, res: Response, next) => {
    try {
      const nonce = req.body?.nonce as string | undefined;
      const item = deps.purchaseService.approve(req.params.id, "owner:dashboard", nonce);
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/purchases/:id/reject", (req: Request, res: Response, next) => {
    try {
      const item = deps.purchaseService.reject(req.params.id, "owner:dashboard");
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/purchases/:id/reveal", (req: Request, res: Response, next) => {
    try {
      const code = deps.purchaseService.revealCode(req.params.id, "dashboard");
      res.json({ code });
    } catch (err) {
      next(err);
    }
  });

  // 9. On-Chain Receipts (Decrypted from Zcash receipts account)
  app.get("/api/receipts", async (_req: Request, res: Response, next) => {
    try {
      // Newest first; unmined (null height) receipts are the newest of all
      const items = (await deps.vault.listReceipts()).sort(
        (a, b) =>
          (b.minedHeight ?? Number.MAX_SAFE_INTEGER) - (a.minedHeight ?? Number.MAX_SAFE_INTEGER)
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}
