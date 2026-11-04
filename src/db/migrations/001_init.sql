PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo','live')),
  source TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_type TEXT NOT NULL,
  country TEXT,
  package_id TEXT,
  value_num REAL,
  face_value TEXT NOT NULL,
  face_currency TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  price_source TEXT NOT NULL,
  quoted_zats INTEGER NOT NULL,
  pay_zats INTEGER,
  pay_to TEXT,
  pay_to_memo TEXT,
  swap_ref TEXT,
  quote_expires_at TEXT,
  policy_decision TEXT,
  policy_reasons TEXT NOT NULL DEFAULT '[]',
  approval_nonce TEXT,
  approval_expires_at TEXT,
  attempt_id TEXT,
  zec_txid TEXT,
  merchant_invoice_id TEXT,
  merchant_order_id TEXT,
  code_ciphertext TEXT,
  code_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id TEXT,
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (purchase_id) REFERENCES purchases(id)
);
CREATE INDEX IF NOT EXISTS idx_events_purchase ON events(purchase_id);

