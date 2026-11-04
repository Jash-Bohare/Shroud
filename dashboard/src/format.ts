/** Formats a zats string as ZEC with 4 decimals, using BigInt so large values stay exact. */
export function zatsToZec(zats: string | null | undefined, decimals = 4): string {
  if (!zats) return "0";
  const z = BigInt(zats);
  const whole = z / 100_000_000n;
  const frac = (z % 100_000_000n).toString().padStart(8, "0");
  const trimmed = frac.slice(0, decimals).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

/** Exact ZEC (up to 8 decimals) for small demo amounts like 0.000115. */
export function zatsToZecExact(zats: string | null | undefined): string {
  return zatsToZec(zats, 8);
}
