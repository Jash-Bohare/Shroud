import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:https";
import { getEnv } from "../src/config/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function httpsRequest(urlStr: string, options: { method: string; headers?: Record<string, string>; body?: any }): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = options.body ? JSON.stringify(options.body) : undefined;
    const headers = {
      ...(options.headers || {}),
      "User-Agent": "Shroud-Smoke/1.0"
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }

    const req = request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: options.method,
        family: 4,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log("=== SMOKE TEST: Bitrefill API v2 ===");
  const env = getEnv();
  const apiKey = env.BITREFILL_API_KEY;

  if (!apiKey) {
    console.warn("BITREFILL_API_KEY not configured in .env. Skipping real API test.");
    return;
  }

  const baseUrl = "https://api.bitrefill.com/v2";
  const authHeaders = {
    Authorization: `Bearer ${apiKey}`
  };

  // 1. Ping
  console.log("1. Testing ping: GET /ping...");
  const pingRes = await httpsRequest(`${baseUrl}/ping`, {
    method: "GET",
    headers: authHeaders
  });
  console.log(`Ping status: ${pingRes.status} -> ${pingRes.data}`);

  // 2. Search products (eSIM India)
  console.log("\n2. Searching products: GET /products/search?q=esim%20india...");
  const searchRes = await httpsRequest(`${baseUrl}/products/search?q=esim%20india`, {
    method: "GET",
    headers: authHeaders
  });
  console.log(`Search status: ${searchRes.status}`);

  const fixturesDir = join(__dirname, "../tests/fixtures/bitrefill");
  if (!existsSync(fixturesDir)) {
    mkdirSync(fixturesDir, { recursive: true });
  }

  if (searchRes.status === 200) {
    const parsed = JSON.parse(searchRes.data);
    const count = Array.isArray(parsed.data) ? parsed.data.length : (Array.isArray(parsed) ? parsed.length : 0);
    console.log(`Found ${count} products.`);
    writeFileSync(join(fixturesDir, "search.json"), JSON.stringify(parsed, null, 2));
    console.log("Saved search response to tests/fixtures/bitrefill/search.json");
  } else {
    console.warn("Search failed:", searchRes.data);
  }

  // 3. Test product check
  console.log("\n3. Testing test products endpoint: GET /products/test-gift-card-code...");
  const testProdRes = await httpsRequest(`${baseUrl}/products/test-gift-card-code`, {
    method: "GET",
    headers: authHeaders
  });
  console.log(`Test product fetch status: ${testProdRes.status}`);
  if (testProdRes.status === 200) {
    console.log("Test products are available for this API key!");
    writeFileSync(join(fixturesDir, "test-product.json"), JSON.stringify(JSON.parse(testProdRes.data), null, 2));
  } else {
    console.log("Test product not accessible or requires different scope:", testProdRes.data);
  }

  console.log("=== BITREFILL SMOKE TEST FINISHED ===");
}

main().catch((err) => {
  console.error("Error in smoke:bitrefill:", err);
  process.exit(1);
});

