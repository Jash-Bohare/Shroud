# FEEDBACK.md: Bitrefill (and Zcash) developer feedback

From the Shroud team, Free Society Hack, Mumbai, 4 Nov 2026. Shroud is an AI agent on Telegram that buys Bitrefill products from a shielded Zcash allowance through the **REST API v2**. Everything below comes from building that, with the exact requests and responses we saw.

## What worked well
- **The catalog is excellent for agents.** `GET /v2/products/search` with `country=IN` returned Swiggy, Amazon Fresh India, Jio and Airtel bundles, and India eSIMs. That covers what Indian users actually ask for.
- **Product detail with packages** is enough for an LLM to pick a denomination without scraping.
- **Personal API keys** were quick to create from the Developers page, and `/v2/ping` made a good smoke test.
- **Test products** let us run the whole invoice → order → code loop without spending money.

## What broke or slowed us down (most impact first)

### 1. Store credit sat in a sub-account the REST API can't reach (cost us ~2 hours)
- **What we saw:** the account showed **$25.00 in Store Credits** (event credits from the Bitrefill team), but `GET /v2/accounts/balance` returned `{"balance":0,"currency":"BTC"}`. Every `POST /v2/invoices` with `payment_method: "balance", auto_pay: true` failed with **`Balance too low`**. This happened *after* our shielded ZEC payment had already been confirmed, so the whole pipeline ran for real and was refused at the last step. The Bitrefill team at the venue didn't know the cause either.
- **Root cause, which we found through the MCP:** balances are per-currency sub-accounts. The MCP `get-balances` tool showed `BTC 0.00000000 (primary: true)`, `EUR 0.00`, **`USD 25.00`**. The REST API only ever uses the **primary** sub-account. Adding `balance_currency: "USD"` to `POST /v2/invoices` is silently ignored (the invoice came back with `payment.currency: "BTC"`). Only the MCP's `buy-products` accepts `balance_currency`.
- **Fix:** we set USD as the primary currency on bitrefill.com. `/accounts/balance` then returned `{"balance":2500,"currency":"USD"}` and balance invoices worked.
- **Side effect that's easy to miss:** a package's `price` in `GET /v2/products/{id}` is quoted in the **primary balance currency**. With BTC primary, the 1GB India eSIM showed `price: 4986` (satoshis). With USD primary, the same package showed `price: 3.89`. Switching your primary currency silently changes the unit of every price your agent reads.
- **Suggestions:**
  1. Support `balance_currency` in REST `POST /v2/invoices`, as the MCP already does.
  2. Make `GET /v2/accounts/balance` return all sub-accounts (like MCP `get-balances`), or at least mark which one is primary.
  3. Make `Balance too low` say which sub-account was checked, e.g. `BTC balance 0; USD balance 25.00 available`.
  4. Return `price_currency` next to each package `price`.
  5. Credit hackathon store credit in the account's primary currency, or tell builders to switch it.

### 1b. The `/mcp/<API_KEY>` URL from the docs is shut down
- `https://api.bitrefill.com/mcp/<key>` (still shown in the eCommerce MCP docs) now returns `"This endpoint has been shut down. Connect to /mcp and send your API key in the Authorization header"`. The error message is helpful, but the docs should match.

### 2. API keys need scopes and spending caps for agents (safety)
- **What we saw:** a personal API key can do everything, and the eCommerce MCP `buy-products` pays from the balance with no per-key limit.
- **Impact:** one prompt injection could drain the account. We kept `buy-products` away from our agent completely and built our own policy engine in front of the API.
- **Suggestion:** key scopes (`catalog:read`, `invoices:create`, `balance:spend`) and a per-key daily or monthly USD cap on balance spending. This is the safety feature that would let people hand an agent a Bitrefill key.

### 3. Document the units of a package's `amount` and `price` (correctness)
- **What we saw:** in `GET /v2/products/{id}`, `amount` turned out to be the face value **in the product's own currency** (`500` for a ₹500 Swiggy card, `2.59` for a USD eSIM). `price` is the amount actually charged, in the account's primary balance currency (see item 1), but neither fact is documented.
- **Impact:** we first read `amount` as USD, so a ₹500 card was priced at **$500** and our policy engine refused it. For an agent, a pricing bug is a spending bug.
- **Suggestion:** document both fields' currency and decimals, and add an explicit `price_usd` (or a price in the requested currency) per package.

### 4. Accept shielded ZEC directly (payments)
- **What we saw:** there's no ZEC payment method, so the private route is shielded ZEC → deshield → NEAR Intents 1Click → USDC → Bitrefill. 1Click has no testnet, and the deshield hop is a public transparent transaction.
- **Suggestion:** accept shielded ZEC to a unified address, with the invoice ID in the encrypted memo. Orders match automatically and nothing is public.

### 5. Test product naming and a sandbox flag (DX)
- **What we saw:** the test products are described in different places under different IDs (the MCP docs name `delos-syldavia`; the REST docs mention `test-*` products). It wasn't clear which ones personal API keys can order, or which payment methods they accept.
- **Suggestion:** one documented sandbox (a `sandbox: true` flag or a sandbox base URL) that settles instantly and returns realistic fake codes.

### 5b. `country=IN` search still returns other countries' products (agents trust filters)
- **What we saw (4 Nov):** `GET /v2/products/search?q=airtel&country=IN` returned `airtel-nigeria`, `airtel-uganda` and `airtel-kenya` **before** `airtel-bundles-india`. `q=amazon&country=IN` led with `amazon-south-africa`.
- **Impact:** an LLM tends to pick the first result. A user in India asking for "an Airtel recharge" could get a Nigerian top-up. We added our own country policy rule (R5) partly because of this.
- **Suggestion:** make `country` a strict filter, or add `strict_country=true`, and return each product's `country_code` in search results so agents can check.

### 6. Invoice expiry and confirmations in the response (protocol)
- **Suggestion:** include `expires_at` (ISO-8601) and the required confirmations or underpayment tolerance in the `POST /invoices` response, so polling workers don't have to guess.

## Zcash side (short)
- **The Orchard → Ironwood change** isn't in most tutorials yet, and it's easy to build against the wrong pool. We only found it by reading release notes and the devtool source (`balance --json` reports `ironwood_spendable`).
- **zcash-devtool** was the fastest way to get shielded sends with memos from Node (`execFile`). `balance` has `--json`, but account lists, addresses and send results are human-readable text that we parse with regexes, which is fragile. `--json` on every command would help agent builders a lot.
- **There's no testnet for 1Click**, so the full private Bitrefill route can't be shown end-to-end on testnet without a stand-in.
