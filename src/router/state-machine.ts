import Database from "better-sqlite3";
import { ShroudError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { Actor, Status } from "../shared/types.js";
import { eventBus } from "./events.js";
import { PurchaseRow, rowToPurchaseView } from "./types.js";

export const ALLOWED_TRANSITIONS: Record<Status, Status[]> = {
  CREATED: ["QUOTED", "FAILED"],
  QUOTED: ["DENIED", "AWAITING_APPROVAL", "APPROVED", "FAILED"],
  AWAITING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED", "DENIED"],
  APPROVED: ["PAYING", "FAILED"],
  PAYING: ["PAID", "FAILED"],
  PAID: ["SWAPPING"],
  SWAPPING: ["SWAPPED", "REFUNDED", "FAILED"],
  SWAPPED: ["ORDERING", "FAILED"],
  ORDERING: ["DELIVERED", "FAILED"],
  DENIED: [],
  REJECTED: [],
  EXPIRED: [],
  DELIVERED: [],
  REFUNDED: [],
  FAILED: []
};

export function canTransition(from: Status, to: Status): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return !!allowed && allowed.includes(to);
}

export interface TransitionOptions {
  data?: Record<string, unknown>;
  actor?: Actor;
  note?: string;
  simulated?: boolean;
}

/**
 * Atomic Compare-and-Set state transition function.
 * Updates the database record only if the current status matches `from`.
 * Records an immutable audit log row in `events` table and emits an event to `eventBus`.
 */
export function transition(
  db: Database.Database,
  id: string,
  from: Status,
  to: Status,
  opts?: TransitionOptions
): void {
  if (!canTransition(from, to)) {
    throw new ShroudError(
      "STATE_CONFLICT",
      `Invalid state transition: cannot move from ${from} to ${to}`
    );
  }

  const now = new Date().toISOString();
  const actor = opts?.actor ?? "system";
  const data = opts?.data ?? {};
  const simulated = opts?.simulated ?? false;

  // Build dynamic SET clause for additional fields
  const setClauses: string[] = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [to, now];

  for (const [key, value] of Object.entries(data)) {
    if (key === "status" || key === "id" || key === "created_at" || key === "updated_at") {
      continue;
    }
    setClauses.push(`${key} = ?`);
    params.push(value);
  }

  // Add WHERE parameters
  params.push(id, from);

  const query = `UPDATE purchases SET ${setClauses.join(", ")} WHERE id = ? AND status = ?`;

  const runTransition = db.transaction(() => {
    const res = db.prepare(query).run(...params);

    if (res.changes === 0) {
      // Check current state to provide a clear error
      const current = db.prepare("SELECT status FROM purchases WHERE id = ?").get(id) as
        | { status: Status }
        | undefined;
      if (!current) {
        throw new ShroudError("STATE_CONFLICT", `Purchase "${id}" does not exist`);
      }
      throw new ShroudError(
        "STATE_CONFLICT",
        `State conflict for purchase "${id}": expected status "${from}" but found "${current.status}"`
      );
    }

    // Insert into events table
    const eventType = to === "AWAITING_APPROVAL" ? "approval_needed" : `status:${to}`;
    const eventDataJson = JSON.stringify(
      {
        ...data,
        note: opts?.note,
        simulated
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v)
    );

    const eventInsert = db
      .prepare(
        `INSERT INTO events (purchase_id, type, from_status, to_status, actor, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, eventType, from, to, actor, eventDataJson, now);

    return {
      eventId: Number(eventInsert.lastInsertRowid),
      eventType
    };
  });

  const { eventId, eventType } = runTransition();

  logger.info(
    { purchaseId: id, from, to, actor, note: opts?.note },
    "Purchase transitioned state"
  );

  // Emit event outside the transaction
  eventBus.emitEvent({
    id: eventId,
    purchaseId: id,
    type: eventType,
    fromStatus: from,
    toStatus: to,
    actor,
    data,
    simulated,
    createdAt: now
  });

  try {
    const updatedRow = db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as
      | PurchaseRow
      | undefined;
    if (updatedRow) {
      eventBus.emit("purchase", rowToPurchaseView(updatedRow));
    }
  } catch (err: any) {
    logger.warn({ err: err.message, id }, "Failed to emit purchase view to eventBus");
  }
}
