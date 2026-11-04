import { describe, it, expect } from "vitest";
import {
  centsToUsd,
  parseUsdToCents,
  zatsToZec,
  zatsToZecExact,
  zecToZats,
  scaleDemoZats
} from "../../src/shared/money.js";

describe("money utilities", () => {
  describe("centsToUsd", () => {
    it("formats integer cents to USD string", () => {
      expect(centsToUsd(600)).toBe("$6.00");
      expect(centsToUsd(1250)).toBe("$12.50");
      expect(centsToUsd(0)).toBe("$0.00");
      expect(centsToUsd(5)).toBe("$0.05");
      expect(centsToUsd(-500)).toBe("-$5.00");
    });
  });

  describe("parseUsdToCents", () => {
    it("parses valid USD strings to integer cents", () => {
      expect(parseUsdToCents("$12.50")).toBe(1250);
      expect(parseUsdToCents("12.5")).toBe(1250);
      expect(parseUsdToCents("0.99")).toBe(99);
      expect(parseUsdToCents("100")).toBe(10000);
      expect(parseUsdToCents("0")).toBe(0);
    });

    it("throws on invalid inputs", () => {
      expect(() => parseUsdToCents("abc")).toThrow();
      expect(() => parseUsdToCents("-5")).toThrow();
    });
  });

  describe("zatsToZec", () => {
    it("formats zats with 4 decimal places and rounding", () => {
      expect(zatsToZec(100_000_000n)).toBe("1.0000");
      expect(zatsToZec(12_345_678n)).toBe("0.1235");
      expect(zatsToZec(10_000n)).toBe("0.0001");
      expect(zatsToZec(0n)).toBe("0.0000");
    });
  });

  describe("zatsToZecExact", () => {
    it("converts zats to exact ZEC string without trailing zeros", () => {
      expect(zatsToZecExact(100_000_000n)).toBe("1");
      expect(zatsToZecExact(123_450_000n)).toBe("1.2345");
      expect(zatsToZecExact(1n)).toBe("0.00000001");
      expect(zatsToZecExact(0n)).toBe("0");
    });
  });

  describe("zecToZats", () => {
    it("parses decimal ZEC strings to exact bigint zats", () => {
      expect(zecToZats("1")).toBe(100_000_000n);
      expect(zecToZats("0.5")).toBe(50_000_000n);
      expect(zecToZats("0.0001")).toBe(10_000n);
      expect(zecToZats("0.00000001")).toBe(1n);
    });

    it("throws on invalid formats", () => {
      expect(() => zecToZats("1.123456789")).toThrow(); // 9 decimals
      expect(() => zecToZats("abc")).toThrow();
    });
  });

  describe("scaleDemoZats", () => {
    it("scales zats correctly using integer arithmetic and bounds by minimum", () => {
      // 10,000,000 zats * 0.01 = 100,000 zats
      expect(scaleDemoZats(10_000_000n, 0.01, 10000n)).toBe(100_000n);
      // Small amount below min falls back to minZats
      expect(scaleDemoZats(50_000n, 0.01, 10000n)).toBe(10000n);
    });
  });
});

