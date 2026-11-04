import Database from "better-sqlite3";
import { getEnv } from "../config/env.js";
import { getDb } from "../db/db.js";
import { MerchantAdapter, Selection } from "../merchant/types.js";
import { evaluate } from "../policy/engine.js";
import { computeSpendState } from "../policy/spend-state.js";
import { PolicyStore } from "../policy/store.js";
import { PriceSource } from "../pricing/types.js";
import { decryptCode } from "../shared/crypto.js";
import { ShroudError } from "../shared/errors.js";
import { generateNonce, generatePurchaseId } from "../shared/ids.js";
import { logger } from "../shared/logger.js";
import { centsToUsd, zatsToZec, zatsToZecExact } from "../shared/money.js";
import {
  Actor,
  BudgetView,
  Mode,
  ProductType,
  PurchaseView,
  Source,
  Status
} from "../shared/types.js";
import { VaultService } from "../zcash/vault.js";
import { transition } from "./state-machine.js";
import { PurchaseRow, QuoteView, SwapExecutor, rowToPurchaseView } from "./types.js";

export { rowToPurchaseView };

export class PurchaseService {
  private readonly db: Database.Database;
  private readonly merchant: MerchantAdapter;
  private readonly pricing: PriceSource;
  private readonly executor: SwapExecutor;
  private readonly vault: VaultService;
  private readonly policyStore: PolicyStore;
  private readonly mode: Mode;
  private readonly approvalTtlMin: number;

  constructor(opts: {
    db?: Database.Database;
    merchant: MerchantAdapter;
    pricing: PriceSource;
    executor: SwapExecutor;
    vault: VaultService;
    policyStore?: PolicyStore;
    mode?: Mode;
    approvalTtlMin?: number;
  }) {
    const env = getEnv();
    this.db = opts.db ?? getDb();
    this.merchant = opts.merchant;
    this.pricing = opts.pricing;
    this.executor = opts.executor;
    this.vault = opts.vault;
    this.policyStore = opts.policyStore ?? new PolicyStore(this.db);
    this.mode = opts.mode ?? env.SHROUD_MODE;
    this.approvalTtlMin = opts.approvalTtlMin ?? env.APPROVAL_TTL_MIN ?? 15;
  }

  async quote(sel: Selection): Promise<QuoteView> {
    const product = await this.merchant.getProduct(sel.productId);
    const priceInfo = await this.merchant.price(sel);
    const quote = await this.pricing.quoteUsdCentsToZats(priceInfo.priceCents);

    // Compute live policy preview for quote
    const policy = this.policyStore.get();
    const vaultBal = await this.vault.getBalance("vault");
    const spendState = computeSpendState(
      this.db,
      new Date(),
      vaultBal.spendableZats,
      quote.zats + 10_000n
    );

    let evaluation = evaluate(
      {
        productId: product.id,
        productType: product.type,
        country: product.country,
        priceCents: priceInfo.priceCents,
        zats: quote.zats,
        source: "agent"
      },
      policy,
      spendState
    );

    // The quote must match what request() will do: include the desk's store-credit cap
    const capProblem = this.executor.preflight?.(priceInfo.priceCents) ?? null;
    if (capProblem) {
      evaluation = {
        ...evaluation,
        decision: "DENY",
        reasons: [...evaluation.reasons, { rule: "REAL_ORDER_CAP", outcome: "DENY", message: capProblem }]
      };
    }

    return {
      productId: product.id,
      productName: product.name,
      productType: product.type,
      country: product.country,
      faceValue: priceInfo.faceValue,
      faceCurrency: priceInfo.faceCurrency,
      priceCents: priceInfo.priceCents,
      priceUsd: centsToUsd(priceInfo.priceCents),
      quotedZats: String(quote.zats),
      quotedZec: zatsToZecExact(quote.zats),
      priceSource: quote.source,
      expiresAt: quote.expiresAt,
      policy: evaluation
    };
  }

  async request(sel: Selection, reason: string, source: Source): Promise<PurchaseView> {
    // 1. Fetch and validate product
    const product = await this.merchant.getProduct(sel.productId);
    if (!product.inStock) {
      throw new ShroudError("OUT_OF_STOCK", `Product "${product.name}" is out of stock`);
    }

    // 2. Fetch authoritative price and quote
    const priceInfo = await this.merchant.price(sel);
    const quote = await this.pricing.quoteUsdCentsToZats(priceInfo.priceCents);

    // 3. Generate ID and insert into SQLite as CREATED
    const id = generatePurchaseId();
    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT INTO purchases (
        id, status, mode, source, reason,
        product_id, product_name, product_type, country,
        package_id, value_num, face_value, face_currency,
        price_cents, price_source, quoted_zats,
        created_at, updated_at
      ) VALUES (
        ?, 'CREATED', ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
    `);

    insertStmt.run(
      id,
      this.mode,
      source,
      reason,
      product.id,
      product.name,
      product.type,
      product.country,
      sel.packageId || null,
      sel.value !== undefined ? sel.value : null,
      priceInfo.faceValue,
      priceInfo.faceCurrency,
      priceInfo.priceCents,
      quote.source,
      quote.zats,
      now,
      now
    );

    // 4. Prepare swap. A failure here must not strand the row in CREATED forever.
    let prep: Awaited<ReturnType<SwapExecutor["prepare"]>>;
    try {
      prep = await this.executor.prepare(this.getRaw(id));
    } catch (err: any) {
      transition(this.db, id, "CREATED", "FAILED", {
        data: { error_code: err.code || "INTERNAL", error_message: err.message },
        actor: "system",
        note: `Payment preparation failed: ${err.message}`
      });
      throw err;
    }

    // 5. Transition to QUOTED with prepared payment fields
    transition(this.db, id, "CREATED", "QUOTED", {
      data: {
        pay_to: prep.payTo,
        pay_zats: prep.payZats,
        pay_to_memo: prep.payToMemo || null,
        swap_ref: prep.swapRef,
        quote_expires_at: prep.quoteExpiresAt || null,
        merchant_invoice_id: prep.invoiceId || null
      },
      actor: source === "agent" ? "agent" : "owner:telegram",
      simulated: false
    });

    // 6. Policy evaluation
    const policy = this.policyStore.get();
    let vaultBal: Awaited<ReturnType<VaultService["getBalance"]>>;
    try {
      vaultBal = await this.vault.getBalance("vault");
    } catch (err: any) {
      transition(this.db, id, "QUOTED", "FAILED", {
        data: { error_code: err.code || "ZCASH_CLI_ERROR", error_message: err.message },
        actor: "system",
        note: `Could not read vault balance: ${err.message}`
      });
      throw err;
    }
    const requiredZats = BigInt(prep.payZats) + 10_000n; // Safety margin for fees
    const spendState = computeSpendState(this.db, new Date(), vaultBal.spendableZats, requiredZats);

    const evalResult = evaluate(
      {
        productId: product.id,
        productType: product.type,
        country: product.country,
        priceCents: priceInfo.priceCents,
        zats: BigInt(prep.payZats),
        source
      },
      policy,
      spendState
    );

    const reasonsList = evalResult.reasons.map((r) => r.message);
    const primaryReason = reasonsList[0] || "";

    if (evalResult.decision === "DENY") {
      transition(this.db, id, "QUOTED", "DENIED", {
        data: {
          policy_decision: "DENY",
          policy_reasons: JSON.stringify(reasonsList)
        },
        actor: "system",
        note: primaryReason || "Purchase denied by policy",
        simulated: false
      });
    } else if (evalResult.decision === "ASK") {
      const nonce = generateNonce();
      const approvalExpiresAt = new Date(
        Date.now() + this.approvalTtlMin * 60 * 1000
      ).toISOString();

      transition(this.db, id, "QUOTED", "AWAITING_APPROVAL", {
        data: {
          policy_decision: "ASK",
          policy_reasons: JSON.stringify(reasonsList),
          approval_nonce: nonce,
          approval_expires_at: approvalExpiresAt
        },
        actor: "system",
        note: primaryReason || "Purchase requires human approval",
        simulated: false
      });
    } else {
      // ALLOW -> Auto-approve
      transition(this.db, id, "QUOTED", "APPROVED", {
        data: {
          policy_decision: "ALLOW",
          policy_reasons: JSON.stringify([])
        },
        actor: "system",
        note: "Auto-approved by policy",
        simulated: false
      });
    }

    return this.get(id);
  }

  approve(id: string, actor: Actor, nonce?: string): PurchaseView {
    const row = this.getRaw(id);
    if (row.status !== "AWAITING_APPROVAL") {
      throw new ShroudError(
        "INVALID_STATE",
        `Cannot approve purchase "${id}" in status ${row.status}`
      );
    }

    if (nonce && row.approval_nonce && nonce !== row.approval_nonce) {
      throw new ShroudError("INVALID_SELECTION", "Approval nonce mismatch");
    }

    if (row.approval_expires_at && new Date() > new Date(row.approval_expires_at)) {
      transition(this.db, id, "AWAITING_APPROVAL", "EXPIRED", {
        actor: "system",
        note: "Approval window expired"
      });
      throw new ShroudError("APPROVAL_EXPIRED", "Approval request has expired");
    }

    // Re-evaluate hard rules (R1 to R10), ignoring human approval rules (R11 & R12)
    const policy = this.policyStore.get();
    const payZats = BigInt(row.pay_zats ?? row.quoted_zats);
    const spendState = computeSpendState(
      this.db,
      new Date(),
      100_000_000_000n, // vault check deferred or optimistic at approve time
      payZats + 10_000n
    );

    const evalResult = evaluate(
      {
        productId: row.product_id,
        productType: row.product_type as ProductType,
        country: row.country,
        priceCents: Number(row.price_cents),
        zats: payZats,
        source: row.source as any
      },
      policy,
      spendState,
      { ignoreAskRules: true }
    );

    if (evalResult.decision === "DENY") {
      const reasonsList = evalResult.reasons.map((r) => r.message);
      transition(this.db, id, "AWAITING_APPROVAL", "DENIED", {
        data: {
          policy_decision: "DENY",
          policy_reasons: JSON.stringify(reasonsList)
        },
        actor: "system",
        note: evalResult.reasons[0]?.message || "Denied on approval re-evaluation",
        simulated: false
      });
      throw new ShroudError(
        "POLICY_VIOLATION",
        evalResult.reasons[0]?.message || "Purchase denied by policy during re-evaluation"
      );
    }

    transition(this.db, id, "AWAITING_APPROVAL", "APPROVED", {
      actor,
      note: `Approved by ${actor}`,
      simulated: false
    });

    return this.get(id);
  }

  reject(id: string, actor: Actor): PurchaseView {
    const row = this.getRaw(id);
    if (row.status !== "AWAITING_APPROVAL") {
      throw new ShroudError(
        "INVALID_STATE",
        `Cannot reject purchase "${id}" in status ${row.status}`
      );
    }

    transition(this.db, id, "AWAITING_APPROVAL", "REJECTED", {
      actor,
      note: `Rejected by ${actor}`,
      simulated: false
    });

    return this.get(id);
  }

  getRaw(id: string): PurchaseRow {
    const row = this.db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as
      | PurchaseRow
      | undefined;
    if (!row) {
      throw new ShroudError("PRODUCT_NOT_FOUND", `Purchase "${id}" not found`);
    }
    return row;
  }

  get(id: string): PurchaseView {
    const row = this.getRaw(id);
    return rowToPurchaseView(row);
  }

  list(opts?: { limit?: number; offset?: number; status?: Status }): PurchaseView[] {
    let sql = "SELECT * FROM purchases";
    const params: unknown[] = [];

    if (opts?.status) {
      sql += " WHERE status = ?";
      params.push(opts.status);
    }

    sql += " ORDER BY created_at DESC";

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
      if (opts?.offset) {
        sql += " OFFSET ?";
        params.push(opts.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as PurchaseRow[];
    return rows.map(rowToPurchaseView);
  }

  async budget(): Promise<BudgetView> {
    const policy = this.policyStore.get();
    const vaultBal = await this.vault.getBalance("vault");
    const spendState = computeSpendState(this.db, new Date(), vaultBal.spendableZats, 0n);

    return {
      leftTodayCents: Math.max(0, policy.dailyLimitCents - spendState.spentLast24hCents),
      leftMonthCents: Math.max(0, policy.monthlyLimitCents - spendState.spentLast30dCents),
      purchasesLeftToday: Math.max(0, policy.maxPurchasesPerDay - spendState.purchasesLast24h),
      autoApproveUpToCents: policy.requireApprovalAboveCents,
      paused: policy.paused,
      vaultSpendableZats: String(vaultBal.spendableZats),
      vaultSpendableZec: zatsToZec(vaultBal.spendableZats)
    };
  }

  revealCode(id: string, actor: "telegram" | "dashboard"): string {
    const row = this.getRaw(id);
    if (!row.code_ciphertext) {
      throw new ShroudError("PRODUCT_NOT_FOUND", `No redemption code available for purchase "${id}"`);
    }

    const decrypted = decryptCode(row.code_ciphertext);

    // Record audit event that code was accessed
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO events (purchase_id, type, from_status, to_status, actor, data, created_at)
         VALUES (?, 'code_revealed', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        row.status,
        row.status,
        `owner:${actor}`,
        JSON.stringify({ codeHash: row.code_hash }),
        now
      );

    logger.info({ purchaseId: id, actor }, "Redemption code revealed to owner");
    return decrypted;
  }
}
