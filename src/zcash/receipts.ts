import { ReceiptRecord } from "../shared/types.js";
import { decodeReceipt } from "./memo.js";

export interface TxCsvRow {
  txid: string;
  minedHeight: number | null;
  memo: string | null;
  [key: string]: unknown;
}

/**
 * Parses raw CSV output from `zcash-devtool wallet list-tx --mode csv`.
 * Handles quoted fields and commas within memo text.
 */
export function parseListTxCsv(csvText: string): TxCsvRow[] {
  if (!csvText || !csvText.trim()) return [];

  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  // Parse header
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const txidIdx = header.findIndex((h) => h.includes("txid") || h.includes("tx_id"));
  const heightIdx = header.findIndex((h) => h.includes("height") || h.includes("mined"));
  const memoIdx = header.findIndex((h) => h.includes("memo"));

  const rows: TxCsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);
    const txid = txidIdx !== -1 ? cols[txidIdx]?.trim() : cols[0]?.trim();
    const heightStr = heightIdx !== -1 ? cols[heightIdx]?.trim() : "";
    const memo = memoIdx !== -1 ? cols[memoIdx] : null;

    if (txid && /^[0-9a-f]{64}$/i.test(txid)) {
      const minedHeight = heightStr && !isNaN(Number(heightStr)) ? Number(heightStr) : null;
      rows.push({
        txid: txid.toLowerCase(),
        minedHeight,
        memo: memo || null
      });
    }
  }

  return rows;
}

/**
 * Filters and extracts SHRD1 receipts from parsed CSV transaction rows.
 */
export function extractReceipts(rows: TxCsvRow[]): ReceiptRecord[] {
  const records: ReceiptRecord[] = [];

  for (const row of rows) {
    if (row.memo) {
      const decoded = decodeReceipt(row.memo);
      if (decoded) {
        records.push({
          txid: row.txid,
          minedHeight: row.minedHeight,
          receipt: decoded
        });
      }
    }
  }

  return records;
}

/**
 * Standard CSV line splitter supporting quoted strings with commas and escaped quotes.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

/**
 * Parses raw text output from `zcash-devtool wallet list-tx` (default text mode).
 * This captures all outputs, including internal wallet transfers that zcash-devtool's CSV mode omits.
 */
export function parseListTxText(text: string): TxCsvRow[] {
  if (!text || !text.trim()) return [];

  const lines = text.split("\n");
  const rows: TxCsvRow[] = [];

  let currentTxid: string | null = null;
  let currentMinedHeight: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Check if line is a 64-character hex txid
    if (/^[0-9a-f]{64}$/i.test(line)) {
      currentTxid = line.toLowerCase();
      currentMinedHeight = null;
      continue;
    }

    // Check for Mined block height
    const minedMatch = line.match(/^Mined:\s*(\d+)/i);
    if (minedMatch) {
      currentMinedHeight = Number(minedMatch[1]);
      continue;
    }

    // Check for Memo: Memo::Text("...")
    const memoMatch = line.match(/Memo:\s*Memo::Text\("(.*)"\)$/);
    if (memoMatch && currentTxid) {
      const rawMemo = memoMatch[1];
      // Unescape rust string literal quotes and backslashes
      const memo = rawMemo.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      rows.push({
        txid: currentTxid,
        minedHeight: currentMinedHeight,
        memo
      });
    }
  }

  return rows;
}


export interface TxOutputRow {
  txid: string;
  minedHeight: number | null;
  valueZats: bigint;
  receivedBy: string | null; // account UUID
  memo: string | null;
}

/** "0.00480696 TAZ" → 480696n, without floating point. */
export function parseZecAmountToZats(text: string): bigint | null {
  const m = text.match(/(\d+)(?:\.(\d{1,8}))?\s*(?:TAZ|ZEC)/);
  if (!m) return null;
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

/**
 * Parses `zcash-devtool wallet list-tx` text output into one row per output, keeping
 * value, receiving account and memo. Used by the desk to match payments to orders by memo.
 */
export function parseListTxOutputs(text: string): TxOutputRow[] {
  const rows: TxOutputRow[] = [];
  let txid: string | null = null;
  let minedHeight: number | null = null;
  let current: TxOutputRow | null = null;

  const flush = () => {
    if (current) rows.push(current);
    current = null;
  };

  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (/^[0-9a-f]{64}$/i.test(line)) {
      flush();
      txid = line.toLowerCase();
      minedHeight = null;
      continue;
    }
    const mined = line.match(/^Mined:\s*(\d+)/i);
    if (mined) {
      minedHeight = Number(mined[1]);
      continue;
    }
    if (/^Output \d+/.test(line) && txid) {
      flush();
      current = { txid, minedHeight, valueZats: 0n, receivedBy: null, memo: null };
      continue;
    }
    if (!current) continue;
    const value = line.match(/^Value:\s*(.+)$/);
    if (value) {
      current.valueZats = parseZecAmountToZats(value[1]) ?? 0n;
      continue;
    }
    const recv = line.match(/^Received by account:\s*([0-9a-f-]{36})/i);
    if (recv) {
      current.receivedBy = recv[1].toLowerCase();
      continue;
    }
    const memo = line.match(/^Memo:\s*Memo::Text\("(.*)"\)$/);
    if (memo) current.memo = memo[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  flush();
  return rows;
}
