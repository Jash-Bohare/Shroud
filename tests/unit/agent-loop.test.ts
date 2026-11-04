import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AssistantTurn, ChatMessage, LlmClient, ToolDef } from "../../src/agent/llm.js";
import { AgentSession } from "../../src/agent/loop.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { VaultService } from "../../src/zcash/vault.js";

function setupTestDb() {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE purchases (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_type TEXT NOT NULL,
      country TEXT,
      package_id TEXT,
      value_num REAL,
      face_value TEXT NOT NULL,
      face_currency TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      price_source TEXT NOT NULL,
      quoted_zats INTEGER NOT NULL,
      pay_zats INTEGER,
      pay_to TEXT,
      pay_to_memo TEXT,
      swap_ref TEXT,
      quote_expires_at TEXT,
      policy_decision TEXT,
      policy_reasons TEXT NOT NULL DEFAULT '[]',
      approval_nonce TEXT,
      approval_expires_at TEXT,
      attempt_id TEXT,
      zec_txid TEXT,
      merchant_invoice_id TEXT,
      merchant_order_id TEXT,
      code_ciphertext TEXT,
      code_hash TEXT,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id TEXT,
      type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      simulated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

class ScriptedFakeLlm implements LlmClient {
  private script: AssistantTurn[];
  private callCount = 0;

  constructor(script: AssistantTurn[]) {
    this.script = script;
  }

  async chat(_messages: ChatMessage[], _tools: ToolDef[]): Promise<AssistantTurn> {
    const turn = this.script[this.callCount];
    this.callCount++;
    if (!turn) {
      return { content: "Default fake reply", toolCalls: [] };
    }
    return turn;
  }
}

describe("Agent Loop with Scripted LLM", () => {
  it("executes tool calls sequentially and returns final assistant response with purchase IDs", async () => {
    const db = setupTestDb();
    const policyStore = new PolicyStore(db);
    const merchant = new MockMerchantAdapter();
    const pricing = new FixedPriceSource(35);
    const fakeVault = {
      getDeskAddress: async () => "utest1deskaddresstest",
      getBalance: async () => ({
        totalZats: 100_000_000n,
        spendableZats: 100_000_000n,
        pendingZats: 0n,
        transparentZats: 0n,
        ironwoodSpendable: 100_000_000n,
        orchardSpendable: 0n,
        saplingSpendable: 0n,
        chainTipHeight: 4500000
      })
    } as unknown as VaultService;

    const executor = new DemoSwapExecutor({
      vault: fakeVault,
      merchant,
      amountScale: 0.01,
      minDemoZats: 10_000n
    });

    const purchaseService = new PurchaseService({
      db,
      merchant,
      pricing,
      executor,
      vault: fakeVault,
      policyStore,
      mode: "demo"
    });

    // Scripted turns:
    // Turn 1: Call search_products
    // Turn 2: Call request_purchase
    // Turn 3: Final text
    const script: AssistantTurn[] = [
      {
        content: null,
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "search_products",
              arguments: JSON.stringify({ query: "swiggy", country: "IN" })
            }
          }
        ]
      },
      {
        content: null,
        toolCalls: [
          {
            id: "call_2",
            type: "function",
            function: {
              name: "request_purchase",
              arguments: JSON.stringify({
                product_id: "swiggy-in",
                package_id: "swiggy-500",
                reason: "Dinner with team"
              })
            }
          }
        ]
      },
      {
        content: "Buying now, I'll message you when it's delivered.",
        toolCalls: []
      }
    ];

    const fakeLlm = new ScriptedFakeLlm(script);
    const session = new AgentSession({
      llm: fakeLlm,
      merchant,
      purchaseService
    });

    const result = await session.run("Can you get me a Swiggy 500 voucher?");
    expect(result.reply).toBe("Buying now, I'll message you when it's delivered.");
    expect(result.purchaseIds).toHaveLength(1);
    expect(result.purchaseIds[0]).toMatch(/^p_/);

    const created = purchaseService.get(result.purchaseIds[0]);
    expect(created.status).toBe("APPROVED");
    expect(created.productName).toBe("Swiggy Food & Instamart Voucher");

    // Check history was saved
    expect(session.getHistory()).toHaveLength(2); // user + assistant

    // Check reset clears history
    session.reset();
    expect(session.getHistory()).toHaveLength(0);
  });

  it("handles step exhaustion cleanly when model loops endlessly", async () => {
    const db = setupTestDb();
    const policyStore = new PolicyStore(db);
    const merchant = new MockMerchantAdapter();
    const pricing = new FixedPriceSource(35);
    const fakeVault = {
      getDeskAddress: async () => "utest1deskaddresstest",
      getBalance: async () => ({
        totalZats: 100_000_000n,
        spendableZats: 100_000_000n,
        pendingZats: 0n,
        transparentZats: 0n,
        ironwoodSpendable: 100_000_000n,
        orchardSpendable: 0n,
        saplingSpendable: 0n,
        chainTipHeight: 4500000
      })
    } as unknown as VaultService;

    const executor = new DemoSwapExecutor({
      vault: fakeVault,
      merchant,
      amountScale: 0.01,
      minDemoZats: 10_000n
    });

    const purchaseService = new PurchaseService({
      db,
      merchant,
      pricing,
      executor,
      vault: fakeVault,
      policyStore,
      mode: "demo"
    });

    // Endless tool loop
    const endlessLoopLlm: LlmClient = {
      chat: async () => ({
        content: null,
        toolCalls: [
          {
            id: "call_inf",
            type: "function",
            function: {
              name: "get_budget",
              arguments: "{}"
            }
          }
        ]
      })
    };

    const session = new AgentSession({
      llm: endlessLoopLlm,
      merchant,
      purchaseService,
      maxSteps: 3
    });

    const res = await session.run("Check budget");
    expect(res.reply).toContain("Sorry, I couldn't finish that. Try rephrasing.");
  });
});


describe("Agent Loop step exhaustion after a purchase", () => {
  it("withholds tools on the last step and reports the real purchase status", async () => {
    const db = setupTestDb();
    const policyStore = new PolicyStore(db);
    const merchant = new MockMerchantAdapter();
    const pricing = new FixedPriceSource(35);
    const fakeVault = {
      getDeskAddress: async () => "utest1deskaddresstest",
      getBalance: async () => ({
        totalZats: 100_000_000n,
        spendableZats: 100_000_000n,
        pendingZats: 0n,
        transparentZats: 0n,
        ironwoodSpendable: 100_000_000n,
        orchardSpendable: 0n,
        saplingSpendable: 0n,
        chainTipHeight: 4500000
      })
    } as unknown as VaultService;
    const executor = new DemoSwapExecutor({ vault: fakeVault, merchant, amountScale: 0.01, minDemoZats: 10_000n });
    const purchaseService = new PurchaseService({
      db,
      merchant,
      pricing,
      executor,
      vault: fakeVault,
      policyStore,
      mode: "demo"
    });

    // Reproduces the 4 Nov Telegram bug: purchase created (ASK), then the model keeps
    // calling tools until the step budget runs out.
    const toolsSeen: number[] = [];
    let call = 0;
    const llm: LlmClient = {
      chat: async (_m, tools) => {
        toolsSeen.push(tools.length);
        call++;
        const fn =
          call === 1
            ? { name: "request_purchase", arguments: JSON.stringify({ product_id: "india-esim", package_id: "esim-10gb", reason: "trip" }) }
            : { name: "get_budget", arguments: "{}" };
        return { content: null, toolCalls: [{ id: `c${call}`, type: "function", function: fn }] };
      }
    };

    const session = new AgentSession({ llm, merchant, purchaseService, maxSteps: 3 });
    const res = await session.run("India eSIM 10GB");

    expect(res.purchaseIds).toHaveLength(1);
    expect(purchaseService.get(res.purchaseIds[0]).status).toBe("AWAITING_APPROVAL");
    expect(res.reply).toContain("needs your approval");
    expect(res.reply).not.toContain("couldn't finish");
    expect(toolsSeen[toolsSeen.length - 1]).toBe(0); // no tools offered on the last step
  });

  it("reports the purchase status if the LLM errors after the purchase was created", async () => {
    const db = setupTestDb();
    const merchant = new MockMerchantAdapter();
    const fakeVault = {
      getDeskAddress: async () => "utest1deskaddresstest",
      getBalance: async () => ({
        totalZats: 100_000_000n, spendableZats: 100_000_000n, pendingZats: 0n, transparentZats: 0n,
        ironwoodSpendable: 100_000_000n, orchardSpendable: 0n, saplingSpendable: 0n, chainTipHeight: 4500000
      })
    } as unknown as VaultService;
    const purchaseService = new PurchaseService({
      db, merchant, pricing: new FixedPriceSource(35),
      executor: new DemoSwapExecutor({ vault: fakeVault, merchant, amountScale: 0.01, minDemoZats: 10_000n }),
      vault: fakeVault, policyStore: new PolicyStore(db), mode: "demo"
    });
    const requireToolFlags: boolean[] = [];
    let call = 0;
    const llm: LlmClient = {
      chat: async (_m, _t, opts) => {
        requireToolFlags.push(!!opts?.requireTool);
        call++;
        if (call === 1) {
          return {
            content: null,
            toolCalls: [{ id: "c1", type: "function", function: { name: "request_purchase", arguments: JSON.stringify({ product_id: "swiggy-in", package_id: "swiggy-500", reason: "dinner" }) } }]
          };
        }
        throw new Error("400 Tool choice is none, but model called a tool");
      }
    };
    const res = await new AgentSession({ llm, merchant, purchaseService }).run("₹500 swiggy");
    expect(res.reply).toContain("Buying Swiggy");
    expect(requireToolFlags[0]).toBe(true); // first step must search/act, not ask
    expect(requireToolFlags[1]).toBe(false);
  });

  it("never buys a substitute by itself after a purchase is blocked (4 Nov ₹500 → ₹100 bug)", async () => {
    const db = setupTestDb();
    const merchant = new MockMerchantAdapter();
    const fakeVault = {
      getDeskAddress: async () => "utest1deskaddresstest",
      getBalance: async () => ({
        totalZats: 100_000_000n, spendableZats: 100_000_000n, pendingZats: 0n, transparentZats: 0n,
        ironwoodSpendable: 100_000_000n, orchardSpendable: 0n, saplingSpendable: 0n, chainTipHeight: 4500000
      })
    } as unknown as VaultService;
    // Real-order mode with a $2.60 cap: swiggy-500 ($6) fails, swiggy-250 ($3) would also fail,
    // so use a cap that the substitute WOULD pass to prove the code (not the cap) stops it.
    const executor = new DemoSwapExecutor({
      vault: fakeVault, merchant, amountScale: 1, minDemoZats: 10_000n,
      orderMode: "balance", maxOrderCents: 500, maxTotalCents: 500, db
    });
    const purchaseService = new PurchaseService({
      db, merchant, pricing: new FixedPriceSource(35), executor, vault: fakeVault,
      policyStore: new PolicyStore(db), mode: "demo"
    });
    const outputs: string[] = [];
    let call = 0;
    const llm: LlmClient = {
      chat: async (m) => {
        const last = m[m.length - 1];
        if (last.role === "tool") outputs.push(String(last.content));
        call++;
        if (call === 1) {
          return { content: null, toolCalls: [{ id: "c1", type: "function", function: { name: "request_purchase", arguments: JSON.stringify({ product_id: "swiggy-in", package_id: "swiggy-500", reason: "asked ₹500" }) } }] };
        }
        if (call === 2) {
          // model "helpfully" tries a smaller card that fits the cap
          return { content: null, toolCalls: [{ id: "c2", type: "function", function: { name: "request_purchase", arguments: JSON.stringify({ product_id: "swiggy-in", package_id: "swiggy-250", reason: "smaller" }) } }] };
        }
        return { content: "₹500 is over the real-order cap; ₹250 would fit. Want that?", toolCalls: [] };
      }
    };
    const res = await new AgentSession({ llm, merchant, purchaseService }).run("get me a ₹500 Swiggy card");
    expect(outputs[0]).toContain("capped at $5.00");
    expect(outputs[1]).toContain("Do not request a different product or amount");
    expect(res.purchaseIds).toHaveLength(0);
    const rows = db.prepare("SELECT package_id, status FROM purchases").all() as any[];
    expect(rows).toEqual([{ package_id: "swiggy-500", status: "FAILED" }]); // no ₹250 purchase exists
  });

  it("never lets the agent claim a purchase that wasn't made (honesty guard)", async () => {
    const db = setupTestDb();
    const merchant = new MockMerchantAdapter();
    const purchaseService = new PurchaseService({
      db, merchant, pricing: new FixedPriceSource(35),
      executor: new DemoSwapExecutor({ vault: {} as VaultService, merchant, amountScale: 0.01, minDemoZats: 10_000n }),
      vault: {} as VaultService, policyStore: new PolicyStore(db), mode: "demo"
    });
    const seen: string[] = [];
    const llm: LlmClient = {
      chat: async (m) => {
        seen.push(String(m[m.length - 1].content));
        // keeps lying even after the correction
        return { content: "Buying Swiggy Money India (₹500) now, I'll message you when it's delivered.", toolCalls: [] };
      }
    };
    const res = await new AgentSession({ llm, merchant, purchaseService }).run("get me a ₹500 Swiggy card");
    expect(seen.some((t) => t.includes("[system check] No purchase was created"))).toBe(true);
    expect(res.reply).toBe("I haven't bought anything yet. Tell me exactly what you'd like and I'll check it against your rules.");
    expect(res.purchaseIds).toHaveLength(0);
  });

  it("still surfaces LLM errors when no purchase was created", async () => {
    const db = setupTestDb();
    const merchant = new MockMerchantAdapter();
    const purchaseService = new PurchaseService({
      db, merchant, pricing: new FixedPriceSource(35),
      executor: new DemoSwapExecutor({ vault: {} as VaultService, merchant, amountScale: 0.01, minDemoZats: 10_000n }),
      vault: {} as VaultService, policyStore: new PolicyStore(db), mode: "demo"
    });
    const llm: LlmClient = { chat: async () => { throw new Error("429 rate limited"); } };
    await expect(new AgentSession({ llm, merchant, purchaseService }).run("hi")).rejects.toThrow("429");
  });
});
