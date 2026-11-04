/**
 * Prints a one-click sign-in link for the local dashboard:
 *   http://localhost:5173/#token=<DASHBOARD_TOKEN>
 * The token sits in the URL fragment, which browsers never send to any server; the
 * dashboard reads it once and removes it from the address bar. Run only on your own machine.
 */
import { getEnv } from "../src/config/env.js";

const env = getEnv();
if (!env.DASHBOARD_TOKEN) {
  console.error("DASHBOARD_TOKEN is not set in .env. Generate one with: openssl rand -hex 24");
  process.exit(1);
}
const origin = env.DASHBOARD_ORIGIN.replace(/\/+$/, "");
console.log("\nOpen this link to sign in to your Shroud dashboard (keep it private):\n");
console.log(`  ${origin}/#token=${encodeURIComponent(env.DASHBOARD_TOKEN)}\n`);
console.log("Requires `npm run dev` (API) and `npm run dashboard` (UI) to be running.\n");
