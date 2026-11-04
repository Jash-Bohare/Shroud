const ZATS_PER_ZEC = 100_000_000n;

/**
 * Formats USD cents as a dollar string, e.g. 600 -> "$6.00"
 */
export function centsToUsd(cents: number | bigint): string {
  const c = typeof cents === "bigint" ? Number(cents) : cents;
  const isNegative = c < 0;
  const absCents = Math.abs(c);
  const dollars = Math.floor(absCents / 100);
  const remainder = absCents % 100;
  const formatted = `$${dollars}.${remainder.toString().padStart(2, "0")}`;
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Parses a USD decimal string to integer cents, e.g. "12.5" -> 1250, "12.50" -> 1250
 */
export function parseUsdToCents(usd: string): number {
  const clean = usd.trim().replace(/^\$/, "");
  const num = Number(clean);
  if (isNaN(num) || num < 0) {
    throw new Error(`Invalid USD amount: "${usd}"`);
  }
  return Math.round(num * 100);
}

/**
 * Formats zatoshis as ZEC for display with 4 decimal places (rounded).
 * e.g. 12345678n -> "0.1235"
 */
export function zatsToZec(zats: bigint): string {
  const isNegative = zats < 0n;
  const abs = isNegative ? -zats : zats;
  const whole = abs / ZATS_PER_ZEC;
  const rem = abs % ZATS_PER_ZEC;

  // Scale 8 decimals to 4 decimals with rounding
  // 1 ZEC = 100,000,000 zats. 4 dp unit is 10,000 zats.
  const tenThousand = 10_000n;
  const fourDp = (rem + 5_000n) / tenThousand;
  
  if (fourDp >= 10_000n) {
    const finalWhole = whole + 1n;
    return `${isNegative ? "-" : ""}${finalWhole}.0000`;
  }

  const paddedRem = fourDp.toString().padStart(4, "0");
  return `${isNegative ? "-" : ""}${whole}.${paddedRem}`;
}

/**
 * Converts zatoshis to an exact ZEC string without loss of precision (up to 8 decimals).
 * Trims trailing zeros, e.g. 123450000n -> "1.2345", 0n -> "0".
 */
export function zatsToZecExact(zats: bigint): string {
  if (zats === 0n) return "0";
  const isNegative = zats < 0n;
  const abs = isNegative ? -zats : zats;
  const whole = abs / ZATS_PER_ZEC;
  const rem = abs % ZATS_PER_ZEC;

  if (rem === 0n) {
    return `${isNegative ? "-" : ""}${whole}`;
  }

  const remStr = rem.toString().padStart(8, "0").replace(/0+$/, "");
  return `${isNegative ? "-" : ""}${whole}.${remStr}`;
}

/**
 * Parses a decimal ZEC string into exact zatoshis (bigint).
 */
export function zecToZats(zecStr: string): bigint {
  const clean = zecStr.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(clean)) {
    throw new Error(`Invalid ZEC amount: "${zecStr}"`);
  }
  const [wholeStr, fracStr = ""] = clean.split(".");
  const whole = BigInt(wholeStr) * ZATS_PER_ZEC;
  const paddedFrac = fracStr.padEnd(8, "0");
  const frac = BigInt(paddedFrac);
  return whole + frac;
}

/**
 * Scales a zat amount by a decimal scale factor (e.g. 0.01 for demo mode)
 * using integer arithmetic, bounded below by minZats.
 */
export function scaleDemoZats(quotedZats: bigint, scale: number, minZats: bigint = 10000n): bigint {
  const scaleBps = BigInt(Math.round(scale * 10000));
  const scaled = (quotedZats * scaleBps) / 10000n;
  return scaled < minZats ? minZats : scaled;
}

