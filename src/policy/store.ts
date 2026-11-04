import Database from "better-sqlite3";
import { z } from "zod";
import { eventBus } from "../router/events.js";
import { ShroudError } from "../shared/errors.js";
import { Actor } from "../shared/types.js";
import { Policy } from "./types.js";

export const DEFAULT_POLICY: Policy = {
  paused: false,
  maxPerPurchaseCents: 2500, // $25.00
  dailyLimitCents: 5000, // $50.00
  monthlyLimitCents: 20000, // $200.00
  maxPurchasesPerDay: 5,
  requireApprovalAboveCents: 1000, // $10.00
  approveAllFirstTimeProducts: false,
  allowedTypes: ["giftcard", "esim", "refill"],
  allowedCountries: [],
  blockedProductIds: [],
  updatedAt: new Date().toISOString()
};

const productTypeSchema = z.enum(["giftcard", "esim", "refill", "bill", "other"]);

export const policySchema = z.object({
  paused: z.boolean(),
  maxPerPurchaseCents: z.number().int().positive(),
  dailyLimitCents: z.number().int().positive(),
  monthlyLimitCents: z.number().int().positive(),
  maxPurchasesPerDay: z.number().int().positive(),
  requireApprovalAboveCents: z.number().int().nonnegative(),
  approveAllFirstTimeProducts: z.boolean(),
  allowedTypes: z.array(productTypeSchema),
  allowedCountries: z.array(z.string().length(2).toUpperCase()),
  blockedProductIds: z.array(z.string()),
  updatedAt: z.string()
});

export const policyPatchSchema = policySchema.partial().omit({ updatedAt: true });

export class PolicyStore {
  constructor(private readonly db: Database.Database) {
    this.ensureDefault();
  }

  private ensureDefault(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as
      | { value: string }
      | undefined;

    if (!row) {
      const initial = { ...DEFAULT_POLICY, updatedAt: new Date().toISOString() };
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES ('policy', ?)")
        .run(JSON.stringify(initial));
    }
  }

  get(): Policy {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as
      | { value: string }
      | undefined;

    if (!row) {
      return { ...DEFAULT_POLICY };
    }

    try {
      return JSON.parse(row.value) as Policy;
    } catch {
      return { ...DEFAULT_POLICY };
    }
  }

  update(patch: Partial<Policy>, actor: Actor): Policy {
    const parseResult = policyPatchSchema.safeParse(patch);
    if (!parseResult.success) {
      throw new ShroudError("INVALID_POLICY", "Invalid policy patch configuration", {
        errors: parseResult.error.format()
      });
    }

    const current = this.get();
    const updated: Policy = {
      ...current,
      ...parseResult.data,
      updatedAt: new Date().toISOString()
    };

    // Validate merged policy
    const validated = policySchema.parse(updated);
    const jsonStr = JSON.stringify(validated);
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('policy', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(jsonStr);

      this.db
        .prepare(
          `INSERT INTO events (type, actor, data, created_at)
           VALUES ('policy_updated', ?, ?, ?)`
        )
        .run(actor, JSON.stringify({ patch: parseResult.data, policy: validated }), now);
    });

    tx();
    eventBus.emit("policy", validated);
    return validated;
  }

  setPaused(paused: boolean, actor: Actor): Policy {
    return this.update({ paused }, actor);
  }
}
