import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function httpsGet(urlStr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "GET",
        family: 4,
        headers: { "User-Agent": "Shroud-Smoke/1.0" }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(urlStr: string, body: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "POST",
        family: 4,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "Shroud-Smoke/1.0"
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log("=== SMOKE TEST: NEAR Intents 1Click API ===");
  const baseUrl = "https://1click.chaindefuser.com";

  // 1. Fetch Tokens
  console.log("1. Fetching token list from", `${baseUrl}/v0/tokens...`);
  const rawTokens = await httpsGet(`${baseUrl}/v0/tokens`);
  const tokens = JSON.parse(rawTokens);
  console.log(`Fetched ${tokens.length} tokens.`);

  const zecTokens = tokens.filter((t: any) => t.blockchain === "zec" || t.symbol === "ZEC");
  const baseUsdcTokens = tokens.filter((t: any) => t.blockchain === "base" && t.symbol === "USDC");

  const zecAsset = zecTokens.find((t: any) => t.assetId === "nep141:zec.omft.near") || zecTokens[0];
  const baseUsdcAsset = baseUsdcTokens.find((t: any) => t.assetId.includes("base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")) || baseUsdcTokens[0];

  console.log("Using ZEC Token:", zecAsset.assetId);
  console.log("Using Base USDC Token:", baseUsdcAsset.assetId);

  const fixturesDir = join(__dirname, "../tests/fixtures/oneclick");
  if (!existsSync(fixturesDir)) {
    mkdirSync(fixturesDir, { recursive: true });
  }
  writeFileSync(join(fixturesDir, "tokens.json"), JSON.stringify(tokens, null, 2));
  console.log("Saved tokens fixture to tests/fixtures/oneclick/tokens.json");

  // 2. Perform Dry Quote
  console.log(`\n2. Requesting Dry Quote: ${zecAsset.assetId} -> ${baseUsdcAsset.assetId} (5.00 USDC)...`);
  const quotePayload = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100, // 1%
    originAsset: zecAsset.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: baseUsdcAsset.assetId,
    amount: "5000000", // 5 USDC (6 decimals)
    refundTo: "jash.near",
    refundType: "INTENTS",
    recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // Base recipient
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  };

  const quoteRaw = await httpsPost(`${baseUrl}/v0/quote`, quotePayload);
  const quote = JSON.parse(quoteRaw);
  console.log("Dry quote successful!");
  console.log(` - Amount In: ${quote.quote.amountInFormatted} ZEC (${quote.quote.amountIn} zats)`);
  console.log(` - Amount Out: ${quote.quote.amountOutFormatted} USDC`);
  console.log(` - Time estimate: ${quote.quote.timeEstimate}s`);

  writeFileSync(join(fixturesDir, "dry-quote.json"), JSON.stringify(quote, null, 2));
  console.log("Saved dry quote fixture to tests/fixtures/oneclick/dry-quote.json");

  console.log("=== ONECLICK SMOKE TEST FINISHED SUCCESSFULLY ===");
}

main().catch((err) => {
  console.error("Error in smoke:oneclick:", err);
  process.exit(1);
});
