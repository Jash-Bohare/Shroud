import { describe, it, expect } from "vitest";
import { createDatabase, runMigrations } from "../../src/db/db.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("database and migrations", () => {
  it("initializes an in-memory database and runs migrations cleanly", () => {
    const db = createDatabase(":memory:");
    const migrationsDir = join(__dirname, "../../src/db/migrations");

    runMigrations(db, migrationsDir);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("settings");
    expect(names).toContain("purchases");
    expect(names).toContain("events");
    expect(names).toContain("schema_migrations");

    // Insert into settings
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("test_key", "{\"hello\":\"world\"}");
    const setting = db.prepare("SELECT value FROM settings WHERE key = ?").get("test_key") as { value: string };
    expect(JSON.parse(setting.value)).toEqual({ hello: "world" });

    // Verify foreign key enforcement
    expect(() => {
      db.prepare(
        "INSERT INTO events (purchase_id, type, actor, created_at) VALUES (?, ?, ?, ?)"
      ).run("non_existent_purchase_id", "test", "system", new Date().toISOString());
    }).toThrow(); // Foreign key constraint failed

    db.close();
  });
});

