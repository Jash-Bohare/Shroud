import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ShroudError } from "../../src/shared/errors.js";
import { eventBus } from "../../src/router/events.js";
import { canTransition, transition } from "../../src/router/state-machine.js";

function setupTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE purchases (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      price_cents INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id TEXT,
      type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("State Machine & EventBus", () => {
  it("validates allowed transitions correctly", () => {
    expect(canTransition("CREATED", "QUOTED")).toBe(true);
    expect(canTransition("QUOTED", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "PAYING")).toBe(true);
    expect(canTransition("PAYING", "PAID")).toBe(true);
    expect(canTransition("DELIVERED", "FAILED")).toBe(false);
    expect(canTransition("CREATED", "DELIVERED")).toBe(false);
  });

  it("performs atomic compare-and-set and records audit event", () => {
    const db = setupTestDb();
    const id = "p_test_1";
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO purchases (id, status, mode, price_cents, created_at, updated_at)
       VALUES (?, 'CREATED', 'demo', 500, ?, ?)`
    ).run(id, now, now);

    let eventEmitted = false;
    eventBus.once("status:QUOTED", (ev) => {
      if (ev.purchaseId === id) eventEmitted = true;
    });

    transition(db, id, "CREATED", "QUOTED", {
      data: { price_cents: 600 },
      actor: "system",
      note: "Quoted successfully"
    });

    const updated = db.prepare("SELECT status, price_cents FROM purchases WHERE id = ?").get(id) as any;
    expect(updated.status).toBe("QUOTED");
    expect(updated.price_cents).toBe(600);
    expect(eventEmitted).toBe(true);

    const event = db.prepare("SELECT * FROM events WHERE purchase_id = ?").get(id) as any;
    expect(event.from_status).toBe("CREATED");
    expect(event.to_status).toBe("QUOTED");
  });

  it("throws STATE_CONFLICT on conflicting compare-and-set", () => {
    const db = setupTestDb();
    const id = "p_conflict_1";
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO purchases (id, status, mode, created_at, updated_at)
       VALUES (?, 'QUOTED', 'demo', ?, ?)`
    ).run(id, now, now);

    // Attempt to transition from CREATED when it is actually QUOTED
    expect(() => {
      transition(db, id, "CREATED", "QUOTED");
    }).toThrow(ShroudError);
  });
});

