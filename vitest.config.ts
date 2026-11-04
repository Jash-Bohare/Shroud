import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests must never inherit live settings from .env (dotenv does not override these).
    // In particular, never let a test run in real store-credit order mode.
    env: {
      BITREFILL_ORDER_MODE: "test",
      DEMO_AMOUNT_SCALE: "0.01"
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"]
    }
  }
});

