import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "../config/env.js";
import { logger } from "../shared/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type ShroudDatabase = Database.Database;

/**
 * Creates and initializes an SQLite database with safeIntegers, foreign keys, and WAL mode.
 */
export function createDatabase(dbPath: string): ShroudDatabase {
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.defaultSafeIntegers(true);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}

/**
 * Applies all pending .sql migrations from src/db/migrations/ in order.
 */
export function runMigrations(db: ShroudDatabase, migrationsDir?: string): void {
  const dir = migrationsDir ?? join(__dirname, "migrations");
  
  // Create schema_migrations table if missing
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
  const applied = new Set(appliedRows.map((r) => r.name));

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (!applied.has(file)) {
      logger.info({ migration: file }, "Applying database migration");
      const sql = readFileSync(join(dir, file), "utf-8");
      
      const transaction = db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
          file,
          new Date().toISOString()
        );
      });

      transaction();
      logger.info({ migration: file }, "Migration applied successfully");
    }
  }
}

let dbInstance: ShroudDatabase | null = null;

/**
 * Returns a singleton database instance.
 */
export function getDb(dbPath?: string): ShroudDatabase {
  if (dbInstance) return dbInstance;
  // Must resolve to the same file the app uses (env DB_PATH). The old fallback to
  // ~/shroud-data/shroud.sqlite made demo:reset clear a database nobody reads.
  const path = dbPath || getEnv().DB_PATH;
  dbInstance = createDatabase(path);
  return dbInstance;
}

