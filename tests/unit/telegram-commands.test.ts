import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/agent/loop.js";
import { runMigrations } from "../../src/db/db.js";
import { MockMerchantAdapter } from "../../src/merchant/mock.js";
import { PolicyStore } from "../../src/policy/store.js";
import { FixedPriceSource } from "../../src/pricing/fixed.js";
import { DemoSwapExecutor } from "../../src/router/demo-swap.js";
import { PurchaseService } from "../../src/router/purchase-service.js";
import { createTelegramBot, formatZecPrice, openApprovalCards, sendApprovalCard, setupTelegramNotifier } from "../../src/telegram/bot.js";
import { VaultService } from "../../src/zcash/vault.js";
import { eventBus } from "../../src/router/events.js";

const OWNER = 123456789;

const receipt = (id: string, height: number | null, n: string) => ({
  txid: `${id.padEnd(64, "0")}`.slice(0, 64),
  minedHeight: height,
  receipt: { v: 1, id, a: `att_${id}`, t: 1793440000, m: "demo", p: "x", n, fv: "500", fc: "INR", u: 600, z: "10000", x: "desk" }
});

function setup() {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  runMigrations(db);
  const policyStore = new PolicyStore(db);
  const merchant = new MockMerchantAdapter();
  const vault = {
    getDeskAddress: async () => "utest1deskaddresstest",
    getBalance: async () => ({
      totalZats: 100_000_000n, spendableZats: 100_000_000n, pendingZats: 0n, transparentZats: 0n,
      ironwoodSpendable: 100_000_000n, orchardSpendable: 0n, saplingSpendable: 0n, chainTipHeight: 4500000
    }),
    // Chain order (oldest first), as listReceipts() returns it
    listReceipts: async () => [
      receipt("p_old1", 100, "Old One"),
      receipt("p_old2", 200, "Old Two"),
      receipt("p_mid", 300, "Middle"),
      receipt("p_x4", 400, "Four"),
      receipt("p_x5", 500, "Five"),
      receipt("p_new", 600, "Newest Mined"),
      receipt("p_pending", null, "Unmined")
    ]
  } as unknown as VaultService;
  const executor = new DemoSwapExecutor({ vault, merchant, amountScale: 0.01, minDemoZats: 10_000n, minConf: 1 });
  const purchaseService = new PurchaseService({
    db, merchant, pricing: new FixedPriceSource(35), executor, vault, policyStore, mode: "demo"
  });
  const agentSession = new AgentSession({
    llm: { chat: async () => ({ content: "ok", toolCalls: [] }) },
    merchant,
    purchaseService
  });
  const bot = createTelegramBot({
    vault, purchaseService, policyStore, agentSession, botToken: "123:TEST", ownerId: OWNER
  });

  const sent: string[] = [];
  const edits: { messageId: number; text: string; hasButtons: boolean }[] = [];
  bot.botInfo = {
    id: 1, is_bot: true, first_name: "Shroud", username: "shroud_test_bot",
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false
  } as any;
  bot.api.config.use(async (_prev, method, payload: any) => {
    if (method === "editMessageText") {
      edits.push({ messageId: payload.message_id, text: String(payload.text), hasButtons: !!payload.reply_markup });
      return { ok: true, result: true } as any;
    }
    if (payload?.text) sent.push(String(payload.text));
    return { ok: true, result: method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: OWNER, type: "private" } } : true } as any;
  });

  let updateId = 1;
  const send = async (text: string) => {
    sent.length = 0;
    const cmdLen = text.startsWith("/") ? text.split(/\s/)[0].length : 0;
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER, type: "private", first_name: "Owner" },
        from: { id: OWNER, is_bot: false, first_name: "Owner" },
        text,
        ...(cmdLen ? { entities: [{ type: "bot_command", offset: 0, length: cmdLen }] } : {})
      }
    } as any);
    return sent.join("\n---\n");
  };

  return { send, policyStore, purchaseService, bot, edits };
}

describe("Telegram commands (driven through grammY handleUpdate)", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("/receipt ignores trailing text after the id (4 Nov bug)", async () => {
    const out = await t.send("/receipt p_mid /history");
    expect(out).toContain("On-Chain Receipt");
    expect(out).toContain("Middle");
  });

  it("/receipt reports a pending receipt and unknown ids clearly", async () => {
    expect(await t.send("/receipt p_pending")).toContain("Block: <b>pending</b>");
    expect(await t.send("/receipt p_nope")).toContain("No on-chain receipt found");
  });

  it("/receipts lists the newest 5, unmined first", async () => {
    const out = await t.send("/receipts");
    expect(out).toContain("latest 5 of 7");
    expect(out.indexOf("Unmined")).toBeLessThan(out.indexOf("Newest Mined"));
    expect(out).not.toContain("Old One");
    expect(out).not.toContain("Old Two");
  });

  it("/deny and /allow edit allowed product types", async () => {
    expect(await t.send("/deny esim")).toContain("esim</b> purchases blocked");
    expect(t.policyStore.get().allowedTypes).not.toContain("esim");
    expect(await t.send("/allow esim")).toContain("esim</b> purchases allowed");
    expect(t.policyStore.get().allowedTypes).toContain("esim");
    expect(await t.send("/allow spaceships")).toContain("Usage");
  });

  it("/countries sets and clears the country allow-list", async () => {
    expect(await t.send("/countries in, us")).toContain("IN, US");
    expect(t.policyStore.get().allowedCountries).toEqual(["IN", "US"]);
    expect(await t.send("/countries any")).toContain("any");
    expect(t.policyStore.get().allowedCountries).toEqual([]);
    expect(await t.send("/countries India")).toContain("2-letter");
  });

  it("/set approve 0 is accepted; /set max 0 is rejected", async () => {
    expect(await t.send("/set approve 0")).toContain("$0.00");
    expect(t.policyStore.get().requireApprovalAboveCents).toBe(0);
    expect(await t.send("/set max 0")).toContain("Invalid number");
  });

  it("replies to unknown commands instead of staying silent", async () => {
    expect(await t.send("/frobnicate")).toContain("Unknown command");
  });

  it("approval card shows the real ZEC price and labels the demo payment", async () => {
    // $20 Steam card at $35/ZEC -> ASK; demo pays 1% of the quote
    const p = await t.purchaseService.request({ productId: "steam-usd", packageId: "steam-20" }, "test", "agent");
    expect(p.status).toBe("AWAITING_APPROVAL");
    const text = formatZecPrice(p);
    expect(text).toMatch(/^0\.5714 ZEC/); // $20 / $35
    expect(text).toContain("Demo: vault pays");
    expect(text).toContain("scaled down");
  });

  describe("approval cards stay in sync with decisions made elsewhere", () => {
    // One bot per app in production; in tests each case builds its own, so reset listeners
    beforeEach(() => {
      eventBus.removeAllListeners("purchase");
      openApprovalCards.clear();
    });

    async function cardFor(t: ReturnType<typeof setup>) {
      setupTelegramNotifier(t.bot, t.purchaseService, OWNER);
      const p = await t.purchaseService.request({ productId: "steam-usd", packageId: "steam-20" }, "test", "agent");
      expect(p.status).toBe("AWAITING_APPROVAL");
      const ctx: any = { reply: async () => ({ message_id: 77, chat: { id: OWNER } }) };
      await sendApprovalCard(ctx, p);
      expect(openApprovalCards.has(p.id)).toBe(true);
      return p;
    }
    const flush = () => new Promise((r) => setTimeout(r, 20));

    it("rejecting in the dashboard edits the Telegram card and removes its buttons", async () => {
      const t = setup();
      const p = await cardFor(t);
      t.purchaseService.reject(p.id, "owner:dashboard");
      await flush();
      const e = t.edits.find((x) => x.messageId === 77)!;
      expect(e.text).toContain("Rejected in the dashboard");
      expect(e.hasButtons).toBe(false);
      expect(openApprovalCards.has(p.id)).toBe(false);
    });

    it("approving in the dashboard edits the card too", async () => {
      const t = setup();
      const p = await cardFor(t);
      t.purchaseService.approve(p.id, "owner:dashboard", p.approvalNonce!);
      await flush();
      expect(t.edits.find((x) => x.messageId === 77)?.text).toContain("Approved in the dashboard");
    });

    it("a pause re-check that blocks the approval is shown on the card", async () => {
      const t = setup();
      const p = await cardFor(t);
      t.policyStore.setPaused(true, "owner:dashboard");
      expect(() => t.purchaseService.approve(p.id, "owner:dashboard", p.approvalNonce!)).toThrow();
      await flush();
      expect(t.edits.find((x) => x.messageId === 77)?.text).toContain("Blocked on re-check");
    });
  });
});
