import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests must never inherit live settings from .env (dotenv does not override these).
    // In particular, never let a test run in real store-credit order mode.
    // Test-only fake secrets, so tests pass on a fresh clone and never read real ones.
    env: {
      BITREFILL_ORDER_MODE: "test",
      DEMO_AMOUNT_SCALE: "0.01",
      DASHBOARD_TOKEN: "test-dashboard-token-not-a-secret",
      CODE_ENCRYPTION_KEY: "dGVzdC1vbmx5LWtleS1ub3QtYS1yZWFsLXNlY3JldCE="
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"]
    }
  }
});

