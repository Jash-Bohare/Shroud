import Database from "better-sqlite3";
import { SpendState } from "./types.js";

const COUNTED_PURCHASES_WHERE = `
  status IN ('APPROVED', 'PAYING', 'PAID', 'SWAPPING', 'SWAPPED', 'ORDERING', 'DELIVERED')
  OR (status = 'FAILED' AND zec_txid IS NOT NULL)
`;

/**
 * Computes live rolling 24-hour and 30-day committed spend metrics directly from the database.
 * Must be executed within an SQLite transaction alongside purchase creation to prevent race conditions.
 */
export function computeSpendState(
  db: Database.Database,
  now: Date,
  vaultSpendableZats: bigint,
  requiredZats: bigint
): SpendState {
  const h24AgoIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const d30AgoIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Rolling 24h spend and count
  const row24 = db
    .prepare(
      `SELECT COALESCE(SUM(price_cents), 0) AS total_cents, COUNT(*) AS count
       FROM purchases
       WHERE (${COUNTED_PURCHASES_WHERE}) AND created_at >= ?`
    )
    .get(h24AgoIso) as { total_cents: number | bigint; count: number | bigint };

  // 2. Rolling 30d spend
  const row30 = db
    .prepare(
      `SELECT COALESCE(SUM(price_cents), 0) AS total_cents
       FROM purchases
       WHERE (${COUNTED_PURCHASES_WHERE}) AND created_at >= ?`
    )
    .get(d30AgoIso) as { total_cents: number | bigint };

  // 3. Previously bought products
  const productRows = db
    .prepare(
      `SELECT DISTINCT product_id
       FROM purchases
       WHERE (${COUNTED_PURCHASES_WHERE})`
    )
    .all() as { product_id: string }[];

  const previouslyBought = new Set<string>(productRows.map((r) => String(r.product_id)));

  return {
    spentLast24hCents: Number(row24.total_cents),
    spentLast30dCents: Number(row30.total_cents),
    purchasesLast24h: Number(row24.count),
    previouslyBoughtProductIds: previouslyBought,
    vaultSpendableZats,
    requiredZats
  };
}

