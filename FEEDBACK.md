# FEEDBACK.md: Bitrefill (and Zcash) developer feedback

From the Shroud team, Free Society Hack, Mumbai, 4 Nov 2026. Shroud is an AI agent on Telegram that buys Bitrefill products from a shielded Zcash allowance through the **REST API v2**. Everything below comes from building that, with the exact requests and responses we saw.

## What worked well
- **The catalog is excellent for agents.** `GET /v2/products/search` with `country=IN` returned Swiggy, Amazon India, Jio and Airtel refills, and eSIMs. That covers what Indian users actually ask for.
- **Product detail with packages** is enough for an LLM to pick a denomination without scraping.
- **Personal API keys** were quick to create from the Developers page, and `/v2/ping` made a good smoke test.
- **Test products** let us run the whole invoice → order → code loop without spending money.

## What broke or slowed us down (most impact first)

### 1. Store credit can't be spent through the API (blocker for us)
- **What we saw:** the account shows **$25.00 in Store Credits** on bitrefill.com (event credits from the Bitrefill team). Through the API, `GET /v2/accounts/balance` returns `{"balance":0,"currency":"BTC"}`. We re-checked on 4 Nov after the credits arrived, and also tried `?currency=USD`, with the same result. `POST /v2/invoices` with `payment_method: "balance", auto_pay: true` fails with **`Balance too low`**. `store_credit` and `credit` return `unsupported_payment_method`.
- **Impact:** our whole pipeline ran for real (agent request → owner approval → shielded ZEC payment → desk confirms by memo), and the order was refused at the very last step. An agent can't spend credit that a user or a sponsor gives it, and the hackathon rule "purchases are real, mentors hand out credits" doesn't work through the REST API.
- **Suggestion:** let `balance` invoices draw on store credit, or add `payment_method: "store_credit"`, and report store credit in `/accounts/balance` with its currency. At minimum, say in the docs which surfaces can spend store credit.

### 2. API keys need scopes and spending caps for agents (safety)
- **What we saw:** a personal API key can do everything, and the eCommerce MCP `buy-products` pays from the balance with no per-key limit.
- **Impact:** one prompt injection could drain the account. We kept `buy-products` away from our agent completely and built our own policy engine in front of the API.
- **Suggestion:** key scopes (`catalog:read`, `invoices:create`, `balance:spend`) and a per-key daily or monthly USD cap on balance spending. This is the safety feature that would let people hand an agent a Bitrefill key.

### 3. Document the units of a package's `amount` and `price` (correctness)
- **What we saw:** in `GET /v2/products/{id}`, `amount` turned out to be the face value **in the product's own currency** (`500` for a ₹500 Swiggy card, `2.59` for a USD eSIM). The unit of `price` isn't documented (`70392` for ₹5000 Swiggy, `4986` for a $2.59 eSIM).
- **Impact:** we first read `amount` as USD, so a ₹500 card was priced at **$500** and our policy engine refused it. For an agent, a pricing bug is a spending bug.
- **Suggestion:** document both fields' currency and decimals, and add an explicit `price_usd` (or a price in the requested currency) per package.

### 4. Accept shielded ZEC directly (payments)
- **What we saw:** there's no ZEC payment method, so the private route is shielded ZEC → deshield → NEAR Intents 1Click → USDC → Bitrefill. 1Click has no testnet, and the deshield hop is a public transparent transaction.
- **Suggestion:** accept shielded ZEC to a unified address, with the invoice ID in the encrypted memo. Orders match automatically and nothing is public.

### 5. Test product naming and a sandbox flag (DX)
- **What we saw:** the test products are described in different places under different IDs (the MCP docs name `delos-syldavia`; the REST docs mention `test-*` products). It wasn't clear which ones personal API keys can order, or which payment methods they accept.
- **Suggestion:** one documented sandbox (a `sandbox: true` flag or a sandbox base URL) that settles instantly and returns realistic fake codes.

### 6. Invoice expiry and confirmations in the response (protocol)
- **Suggestion:** include `expires_at` (ISO-8601) and the required confirmations or underpayment tolerance in the `POST /invoices` response, so polling workers don't have to guess.

## Zcash side (short)
- **The Orchard → Ironwood change** isn't in most tutorials yet, and it's easy to build against the wrong pool. We only found it by reading release notes and the devtool source (`balance --json` reports `ironwood_spendable`).
- **zcash-devtool** was the fastest way to get shielded sends with memos from Node (`execFile`). `balance` has `--json`, but account lists, addresses and send results are human-readable text that we parse with regexes, which is fragile. `--json` on every command would help agent builders a lot.
- **There's no testnet for 1Click**, so the full private Bitrefill route can't be shown end-to-end on testnet without a stand-in.
