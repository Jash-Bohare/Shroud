import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import QRCode from "qrcode";
import { AgentSession } from "../agent/loop.js";
import { getEnv } from "../config/env.js";
import { PolicyStore } from "../policy/store.js";
import { eventBus } from "../router/events.js";
import { PurchaseService } from "../router/purchase-service.js";
import { logger } from "../shared/logger.js";
import { centsToUsd, zatsToZec, zatsToZecExact } from "../shared/money.js";
import { PurchaseView } from "../shared/types.js";
import { VaultService } from "../zcash/vault.js";

export interface TelegramBotDeps {
  vault: VaultService;
  purchaseService: PurchaseService;
  policyStore: PolicyStore;
  agentSession: AgentSession;
  botToken?: string;
  ownerId?: number;
  /** Demo mode: store-credit budget for real Bitrefill orders */
  deskBudget?: () => { orderMode: "test" | "balance"; maxTotalCents: number; leftCents: number };
}

export function createTelegramBot(deps: TelegramBotDeps): Bot<Context> {
  const env = getEnv();
  const token = deps.botToken || env.TELEGRAM_BOT_TOKEN;
  const ownerId = deps.ownerId ?? env.TELEGRAM_OWNER_ID;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN must be configured to initialize bot");
  }

  const bot = new Bot(token);

  // 1. Owner-lock security middleware: drop all updates not from TELEGRAM_OWNER_ID
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId !== ownerId) {
      logger.warn(
        { fromId, ownerId, text: ctx.message?.text },
        "Unauthorized Telegram message ignored by owner lock"
      );
      return;
    }
    await next();
  });

  // 2. Command Handlers
  bot.command("start", async (ctx) => {
    const network = env.ZCASH_NETWORK === "test" ? " · <i>Zcash testnet</i>" : "";
    const text =
      `🛡️ <b>Welcome to Shroud</b>${network}\n\n` +
      `I am your private spending vault assistant. Tell me what you need (e.g. <i>"get me an India eSIM for a week"</i> or <i>"buy $10 Steam card"</i>) and I'll find options and manage payments from your shielded Zcash vault.\n\n` +
      `Commands:\n` +
      `• /fund — Deposit ZEC to your shielded vault\n` +
      `• /balance — Check vault balance\n` +
      `• /budget — View daily & monthly spending limits\n` +
      `• /rules — View or configure policy caps\n` +
      `• /pause & /resume — Emergency kill switch\n` +
      `• /history — View recent purchases\n` +
      `• /receipts — View on-chain receipts\n` +
      `• /help — Full command reference`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    const text =
      `📖 <b>Shroud Commands Reference</b>\n\n` +
      `<b>Vault & Balance:</b>\n` +
      `• /fund — Deposit address & QR code\n` +
      `• /balance — Spendable and pending ZEC\n` +
      `• /budget — Remaining allowances today and this month\n` +
      `• /receipts — View latest trial-decrypted on-chain receipts\n` +
      `• /receipt &lt;id&gt; — View receipt for specific purchase\n` +
      `• /code &lt;id&gt; — Re-display redeemed gift card code\n\n` +
      `<b>Rules & Controls:</b>\n` +
      `• /rules — Show current policy\n` +
      `• /set max &lt;USD&gt; — Per-purchase hard cap\n` +
      `• /set daily &lt;USD&gt; — Rolling 24h budget limit\n` +
      `• /set monthly &lt;USD&gt; — Rolling 30d budget limit\n` +
      `• /set approve &lt;USD&gt; — Auto-approve threshold\n` +
      `• /set count &lt;N&gt; — Max purchases per 24 hours\n` +
      `• /allow &lt;type&gt; — Whitelist category (giftcard, esim, refill)\n` +
      `• /deny &lt;type&gt; — Blacklist category\n` +
      `• /countries &lt;IN,US | any&gt; — Restrict countries\n` +
      `• /pause & /resume — Emergency spending kill switch\n\n` +
      `<b>Chat & Mode:</b>\n` +
      `• /reset — Clear chat conversation memory\n` +
      `• /mode — View mode and environment`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("fund", async (ctx) => {
    const addr = await deps.vault.getFundingAddress();
    const qrBuffer = await QRCode.toBuffer(addr, { margin: 2, width: 300 });

    const caption =
      `💳 <b>Shielded Vault Funding Address</b>\n\n` +
      `Send testnet TAZ to this Unified Address (shielded receiver):\n` +
      `<code>${addr}</code>\n\n` +
      (env.SHROUD_MODE === "demo"
        ? `Faucet: <a href="https://fauzec.com">fauzec.com</a>`
        : ``);

    await ctx.replyWithPhoto(new InputFile(qrBuffer, "vault_address.png"), {
      caption,
      parse_mode: "HTML"
    });
  });

  bot.command("balance", async (ctx) => {
    const b = await deps.vault.getBalance("vault");
    const spendableZec = (Number(b.spendableZats) / 100_000_000).toFixed(4);
    const totalZec = (Number(b.totalZats) / 100_000_000).toFixed(4);

    const text =
      `💰 <b>Vault Balance</b>\n\n` +
      `• Spendable: <b>${spendableZec} ZEC</b> (${b.spendableZats.toString()} zats)\n` +
      `• Total: <b>${totalZec} ZEC</b>\n` +
      `• Chain Height: <b>${b.chainTipHeight}</b>\n\n` +
      `Top up anytime with /fund`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("budget", async (ctx) => {
    const b = await deps.purchaseService.budget();
    const text =
      `📊 <b>Live Spending Budget</b>\n\n` +
      `• Left today (24h): <b>${centsToUsd(b.leftTodayCents)}</b>\n` +
      `• Left this month (30d): <b>${centsToUsd(b.leftMonthCents)}</b>\n` +
      `• Purchases left today: <b>${b.purchasesLeftToday}</b>\n` +
      `• Auto-approve up to: <b>${centsToUsd(b.autoApproveUpToCents)}</b>\n` +
      `• Vault spendable: <b>${b.vaultSpendableZec} ${env.ZCASH_NETWORK === "test" ? "TAZ" : "ZEC"}</b>\n` +
      (deps.deskBudget && deps.deskBudget().orderMode === "balance"
        ? `• Real-order store credit: <b>${centsToUsd(deps.deskBudget().leftCents)}</b> left of ${centsToUsd(deps.deskBudget().maxTotalCents)}\n`
        : "") +
      `• Status: ${b.paused ? "🔴 <b>PAUSED (Kill switch active)</b>" : "🟢 <b>Active</b>"}`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("rules", async (ctx) => {
    const p = deps.policyStore.get();
    const text =
      `📋 <b>Current Policy Rules</b>\n\n` +
      `• Max per purchase: <b>${centsToUsd(p.maxPerPurchaseCents)}</b>\n` +
      `• Daily limit (24h): <b>${centsToUsd(p.dailyLimitCents)}</b>\n` +
      `• Monthly limit (30d): <b>${centsToUsd(p.monthlyLimitCents)}</b>\n` +
      `• Max purchases/day: <b>${p.maxPurchasesPerDay}</b>\n` +
      `• Auto-approve up to: <b>${centsToUsd(p.requireApprovalAboveCents)}</b>\n` +
      `• Approve 1st-time items: <b>${p.approveAllFirstTimeProducts ? "Yes" : "No"}</b>\n` +
      `• Allowed types: <b>${p.allowedTypes.join(", ") || "none"}</b>\n` +
      `• Allowed countries: <b>${p.allowedCountries.join(", ") || "any"}</b>\n` +
      `• Blocked SKUs: <b>${p.blockedProductIds.length ? p.blockedProductIds.join(", ") : "none"}</b>\n` +
      `• Kill switch: ${p.paused ? "🔴 <b>PAUSED</b>" : "🟢 <b>ACTIVE</b>"}\n\n` +
      `<i>Edit with /set, /allow, /deny, /pause, /resume</i>`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("set", async (ctx) => {
    const parts = (ctx.match || "").trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply("Usage: <code>/set max 25</code>, <code>/set daily 50</code>, <code>/set approve 10</code>", {
        parse_mode: "HTML"
      });
      return;
    }

    const [field, valStr] = parts;
    const num = parseFloat(valStr);
    // approve 0 is valid: every purchase then needs an explicit tap
    if (isNaN(num) || num < 0 || (num === 0 && field !== "approve")) {
      await ctx.reply("Invalid number provided.", { parse_mode: "HTML" });
      return;
    }

    const cents = Math.round(num * 100);
    try {
      if (field === "max") {
        deps.policyStore.update({ maxPerPurchaseCents: cents }, "owner:telegram");
        await ctx.reply(`✅ Max per purchase updated to <b>$${num.toFixed(2)}</b>`, { parse_mode: "HTML" });
      } else if (field === "daily") {
        deps.policyStore.update({ dailyLimitCents: cents }, "owner:telegram");
        await ctx.reply(`✅ Daily limit updated to <b>$${num.toFixed(2)}</b>`, { parse_mode: "HTML" });
      } else if (field === "monthly") {
        deps.policyStore.update({ monthlyLimitCents: cents }, "owner:telegram");
        await ctx.reply(`✅ Monthly limit updated to <b>$${num.toFixed(2)}</b>`, { parse_mode: "HTML" });
      } else if (field === "approve") {
        deps.policyStore.update({ requireApprovalAboveCents: cents }, "owner:telegram");
        await ctx.reply(`✅ Auto-approve limit updated to <b>$${num.toFixed(2)}</b>`, { parse_mode: "HTML" });
      } else if (field === "count") {
        deps.policyStore.update({ maxPurchasesPerDay: Math.round(num) }, "owner:telegram");
        await ctx.reply(`✅ Daily count limit updated to <b>${Math.round(num)}</b>`, { parse_mode: "HTML" });
      } else {
        await ctx.reply(`Unknown setting: "${field}". Options: max, daily, monthly, approve, count`, {
          parse_mode: "HTML"
        });
      }
    } catch (err: any) {
      await ctx.reply(`Failed to update policy: ${err.message}`);
    }
  });

  const POLICY_TYPES = ["giftcard", "esim", "refill", "bill"] as const;
  type PolicyType = (typeof POLICY_TYPES)[number];
  const parseType = (raw: string): PolicyType | null => {
    const t = raw.trim().toLowerCase();
    return (POLICY_TYPES as readonly string[]).includes(t) ? (t as PolicyType) : null;
  };

  bot.command("allow", async (ctx) => {
    const type = parseType(ctx.match || "");
    if (!type) {
      await ctx.reply(`Usage: <code>/allow &lt;type&gt;</code>. Types: ${POLICY_TYPES.join(", ")}`, {
        parse_mode: "HTML"
      });
      return;
    }
    const current = deps.policyStore.get().allowedTypes;
    const next = current.includes(type) ? current : [...current, type];
    const p = deps.policyStore.update({ allowedTypes: next }, "owner:telegram");
    await ctx.reply(`✅ <b>${type}</b> purchases allowed. Allowed types: <b>${p.allowedTypes.join(", ")}</b>`, {
      parse_mode: "HTML"
    });
  });

  bot.command("deny", async (ctx) => {
    const type = parseType(ctx.match || "");
    if (!type) {
      await ctx.reply(`Usage: <code>/deny &lt;type&gt;</code>. Types: ${POLICY_TYPES.join(", ")}`, {
        parse_mode: "HTML"
      });
      return;
    }
    const next = deps.policyStore.get().allowedTypes.filter((t) => t !== type);
    const p = deps.policyStore.update({ allowedTypes: next }, "owner:telegram");
    await ctx.reply(
      `🚫 <b>${type}</b> purchases blocked. Allowed types: <b>${p.allowedTypes.join(", ") || "none"}</b>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("countries", async (ctx) => {
    const raw = (ctx.match || "").trim();
    if (!raw) {
      await ctx.reply("Usage: <code>/countries IN,US</code> or <code>/countries any</code>", {
        parse_mode: "HTML"
      });
      return;
    }
    const codes =
      raw.toLowerCase() === "any"
        ? []
        : raw
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((c) => c.toUpperCase());
    if (codes.some((c) => !/^[A-Z]{2}$/.test(c))) {
      await ctx.reply("Use 2-letter country codes, e.g. <code>/countries IN,US</code>", {
        parse_mode: "HTML"
      });
      return;
    }
    const p = deps.policyStore.update({ allowedCountries: codes }, "owner:telegram");
    await ctx.reply(`🌍 Allowed countries: <b>${p.allowedCountries.join(", ") || "any"}</b>`, {
      parse_mode: "HTML"
    });
  });

  bot.command("pause", async (ctx) => {
    deps.policyStore.setPaused(true, "owner:telegram");
    await ctx.reply("🔴 <b>Spending paused</b>. All purchase executions are halted.", {
      parse_mode: "HTML"
    });
  });

  bot.command("resume", async (ctx) => {
    deps.policyStore.setPaused(false, "owner:telegram");
    await ctx.reply("🟢 <b>Spending resumed</b>. Policy engine active.", { parse_mode: "HTML" });
  });

  bot.command("history", async (ctx) => {
    const list = deps.purchaseService.list({ limit: 10 });
    if (!list.length) {
      await ctx.reply("No purchases found yet.", { parse_mode: "HTML" });
      return;
    }

    let text = `📜 <b>Recent Purchases</b>\n\n`;
    for (const p of list) {
      const emoji =
        p.status === "DELIVERED"
          ? "✅"
          : p.status === "APPROVED" || p.status === "PAYING" || p.status === "PAID"
            ? "⏳"
            : p.status === "AWAITING_APPROVAL"
              ? "🛒"
              : "❌";

      text += `${emoji} <b>${p.productName}</b> — ${p.priceUsd} (${p.status})\n`;
      text += `   <code>${p.id}</code> · <i>${p.createdAt.slice(0, 16).replace("T", " ")}</i>\n\n`;
    }

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("receipts", async (ctx) => {
    const receipts = await deps.vault.listReceipts();
    if (!receipts.length) {
      await ctx.reply("No on-chain receipts found in receipts account yet.", {
        parse_mode: "HTML"
      });
      return;
    }

    // listReceipts() is in chain order (oldest first); show the newest.
    const latest = [...receipts].sort((a, b) => (b.minedHeight ?? Number.MAX_SAFE_INTEGER) - (a.minedHeight ?? Number.MAX_SAFE_INTEGER)).slice(0, 5);
    let text = `🧾 <b>On-Chain Decrypted Receipts</b> (latest ${latest.length} of ${receipts.length})\n\n`;
    text += `<i>Decrypted directly from shielded memos on Zcash testnet:</i>\n\n`;

    for (const r of latest) {
      text += `• <b>${r.receipt.n}</b> — ${centsToUsd(r.receipt.u)}\n`;
      text += `  TX: <code>${r.txid.slice(0, 16)}...</code>\n`;
      text += `  ID: <code>${r.receipt.id}</code>\n\n`;
    }

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("receipt", async (ctx) => {
    // First token only: a pasted "p_… /history" must not become part of the id
    const id = (ctx.match || "").trim().split(/\s+/)[0] ?? "";
    if (!id) {
      await ctx.reply("Usage: <code>/receipt &lt;purchase_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }

    const receipts = await deps.vault.listReceipts();
    const r = receipts.find((x) => x.receipt.id === id);
    if (!r) {
      await ctx.reply(
        `No on-chain receipt found for <code>${id}</code> yet. It appears once the payment is mined and synced (about 1–2 min).`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const text =
      `🧾 <b>On-Chain Receipt</b>\n\n` +
      `• Product: <b>${r.receipt.n}</b> (${r.receipt.fc} ${r.receipt.fv})\n` +
      `• Price: <b>${centsToUsd(r.receipt.u)}</b>\n` +
      `• Paid: <b>${zatsToZecExact(BigInt(r.receipt.z))} ZEC</b> (${r.receipt.x === "desk-balance" ? "testnet; real Bitrefill order from store credit" : r.receipt.m === "demo" ? "testnet; Bitrefill test product" : "live 1Click swap"})\n` +
      `• Time: ${new Date(r.receipt.t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC\n` +
      `• Block: <b>${r.minedHeight ?? "pending"}</b>\n` +
      `• TX: <code>${r.txid}</code>\n\n` +
      `<i>Decrypted from a shielded memo with your viewing key. Nobody else can read it.</i>`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("code", async (ctx) => {
    // First token only: a pasted "p_… /history" must not become part of the id
    const id = (ctx.match || "").trim().split(/\s+/)[0] ?? "";
    if (!id) {
      await ctx.reply("Usage: <code>/code &lt;purchase_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }

    try {
      const code = deps.purchaseService.revealCode(id, "telegram");
      await ctx.reply(
        `🎁 <b>Redemption Code for ${id}:</b>\n\n<tg-spoiler>${code}</tg-spoiler>`,
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await ctx.reply(`Could not retrieve code: ${err.message}`);
    }
  });

  bot.command("reset", async (ctx) => {
    deps.agentSession.reset();
    await ctx.reply("🧹 Chat conversation memory cleared.", { parse_mode: "HTML" });
  });

  bot.command("mode", async (ctx) => {
    await ctx.reply(
      `⚙️ <b>Shroud setup</b>\n` +
      `• Zcash network: <b>${env.ZCASH_NETWORK === "test" ? "testnet (TAZ)" : "mainnet"}</b>\n` +
      `• Bitrefill: <b>${env.BITREFILL_MODE === "api" ? "live API" : "mock"}</b>\n` +
      `• Fulfilment: ${
        env.SHROUD_MODE === "live"
          ? "1Click swap → Bitrefill invoice (mainnet)"
          : env.BITREFILL_ORDER_MODE === "balance"
            ? `real Bitrefill products. Testnet has no ZEC swap, so the Shroud desk is merchant of record: it confirms your shielded payment, then pays Bitrefill from store credit (max ${centsToUsd(env.BITREFILL_BALANCE_MAX_ORDER_CENTS)}/order, ${centsToUsd(env.BITREFILL_BALANCE_MAX_TOTAL_CENTS)} total)`
            : "Bitrefill test product stands in for the item (simulated, no real money)"
      }\n` +
      `• Vault pays: ${env.DEMO_AMOUNT_SCALE >= 1 ? "full price in TAZ" : `${env.DEMO_AMOUNT_SCALE * 100}% of the price in TAZ (scaled)`}`,
      { parse_mode: "HTML" }
    );
  });

  // 3. Callback Queries for Approval Cards
  bot.callbackQuery(/^ap:(p_[^:]+):([a-f0-9]+)$/, async (ctx) => {
    const purchaseId = ctx.match[1];
    const nonce = ctx.match[2];
    openApprovalCards.delete(purchaseId);

    try {
      const approved = deps.purchaseService.approve(purchaseId, "owner:telegram", nonce);
      await ctx.editMessageText(
        `✅ <b>Approved</b> by you\n\n` +
        `<b>${approved.productName}</b> — ${approved.priceUsd}\n` +
        `Status: <b>${approved.status}</b>. Processing payment from shielded vault...`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery({ text: "Purchase approved!" });
    } catch (err: any) {
      await ctx.answerCallbackQuery({ text: `Approval failed: ${err.message}`, show_alert: true });
      // The decision is final either way: show why and remove the buttons
      await ctx
        .editMessageText(`⚠️ <b>Approval not possible</b>: ${err.message}\n\nThis tap changed nothing. Send /history to see its current status.`, { parse_mode: "HTML" })
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^rj:(p_[^:]+):([a-f0-9]+)$/, async (ctx) => {
    const purchaseId = ctx.match[1];
    openApprovalCards.delete(purchaseId);

    try {
      const rejected = deps.purchaseService.reject(purchaseId, "owner:telegram");
      await ctx.editMessageText(
        `❌ <b>Rejected</b> by you\n\n` +
        `<b>${rejected.productName}</b> — ${rejected.priceUsd}\n` +
        `Status: <b>REJECTED</b>`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery({ text: "Purchase rejected." });
    } catch (err: any) {
      await ctx.answerCallbackQuery({ text: `Reject failed: ${err.message}`, show_alert: true });
      // The decision is final either way: show why and remove the buttons
      await ctx
        .editMessageText(`⚠️ <b>Reject not possible</b>: ${err.message}\n\nThis tap changed nothing. Send /history to see its current status.`, { parse_mode: "HTML" })
        .catch(() => {});
    }
  });

  // 4. Natural language message routing to agent
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      // Registered commands are handled above; anything reaching here is unknown
      await ctx.reply("Unknown command. Send /help for the list.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    try {
      const res = await deps.agentSession.run(text);

      // If a purchase was created and requires approval, send an approval card!
      for (const pId of res.purchaseIds) {
        const purchase = deps.purchaseService.get(pId);
        if (purchase.status === "AWAITING_APPROVAL" && purchase.approvalNonce) {
          await sendApprovalCard(ctx, purchase);
        }
      }

      // Replies are sent as plain text; drop markdown emphasis the model sometimes adds (**x**, __x__, `x`)
      await ctx.reply(res.reply.replace(/\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`/g, "$1$2$3"));
    } catch (err: any) {
      logger.error({ err: err.message }, "Agent error handling Telegram message");
      await ctx.reply(`Sorry, I encountered an error: ${err.message}`);
    }
  });

  return bot;
}

/**
 * Shows the real quoted ZEC price. In demo mode the vault only sends a scaled-down
 * amount to the desk, so that is labelled separately rather than passed off as the price.
 */
export function formatZecPrice(p: PurchaseView): string {
  const quoted = `${zatsToZec(BigInt(p.quotedZats))} ZEC`;
  if (p.mode !== "demo" || !p.paidZats || p.paidZats === p.quotedZats) return quoted;
  return `${quoted}\n<i>Demo: vault pays ${zatsToZecExact(BigInt(p.paidZats))} TAZ on testnet (scaled down)</i>`;
}

/**
 * Approval cards still showing buttons, by purchase id. When the decision is made elsewhere
 * (dashboard, expiry, re-check), the notifier edits the card so its buttons can't mislead.
 */
export const openApprovalCards = new Map<string, { chatId: number; messageId: number; header: string }>();

/**
 * Sends an interactive approval card with Approve/Reject inline buttons.
 */
export async function sendApprovalCard(ctx: Context, p: PurchaseView): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `ap:${p.id}:${p.approvalNonce}`)
    .text("❌ Reject", `rj:${p.id}:${p.approvalNonce}`);

  const cardText =
    `🛒 <b>Approval Needed</b>\n\n` +
    `<b>${p.productName}</b> — ${p.faceCurrency} ${p.faceValue} (${p.country || "Global"})\n` +
    `Price: <b>${p.priceUsd}</b> ≈ ${formatZecPrice(p)}\n` +
    `Why: <i>"${p.reason}"</i> (agent)\n` +
    `Rule: ${p.policyReasons[0] || "Exceeds auto-approve threshold"}\n\n` +
    `Please review and confirm:`;

  const msg = await ctx.reply(cardText, {
    reply_markup: keyboard,
    parse_mode: "HTML"
  });
  if (msg?.chat?.id !== undefined && msg.message_id !== undefined) {
    openApprovalCards.set(p.id, {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      header: `<b>${p.productName}</b> — ${p.priceUsd}`
    });
  }
}

/**
 * Subscribes to router purchase events and sends delivery notifications with spoiler code.
 */
export function setupTelegramNotifier(
  bot: Bot<Context>,
  purchaseService: PurchaseService,
  ownerChatId: number
): void {
  eventBus.on("purchase", async (p: PurchaseView) => {
    const card = openApprovalCards.get(p.id);
    if (card && p.status !== "AWAITING_APPROVAL") {
      openApprovalCards.delete(p.id);
      const outcome =
        p.status === "APPROVED"
          ? "✅ <b>Approved in the dashboard</b>. Processing payment from the shielded vault..."
          : p.status === "REJECTED"
            ? "❌ <b>Rejected in the dashboard</b>. Nothing was paid."
            : p.status === "EXPIRED"
              ? "⌛ <b>Approval expired</b>. Nothing was paid."
              : p.status === "DENIED"
                ? `🚫 <b>Blocked on re-check</b>: ${p.policyReasons[0] ?? "a spending rule"}. Nothing was paid.`
                : `Status: <b>${p.status}</b>`;
      // Editing without reply_markup removes the Approve/Reject buttons
      await bot.api
        .editMessageText(card.chatId, card.messageId, `${outcome}\n\n${card.header}`, { parse_mode: "HTML" })
        .catch((err) => logger.warn({ err: err.message, purchaseId: p.id }, "Could not update approval card"));
    }

    try {
      const terminalNotices: Partial<Record<PurchaseView["status"], string>> = {
        FAILED: `⚠️ <b>Purchase failed</b>\n\n<b>${p.productName}</b> — ${p.priceUsd}\n${
          p.settlement === "bitrefill-store-credit" && p.zecTxid
            ? "The TAZ payment went through. Check your Bitrefill account (orders and store credit) before retrying; Shroud never re-places a real order on its own."
            : p.zecTxid
              ? "A payment was sent; check /history and the dashboard before retrying."
              : "No funds were spent. You can try again."
        }`,
        REFUNDED: `↩️ <b>Swap refunded</b>\n\n<b>${p.productName}</b> — ${p.priceUsd}\nFunds were returned to your vault.`,
        EXPIRED: `⌛ <b>Approval expired</b>\n\n<b>${p.productName}</b> — ${p.priceUsd}\nNothing was paid. Ask again if you still want it.`
      };
      const notice = terminalNotices[p.status];
      if (notice) {
        await bot.api.sendMessage(ownerChatId, notice, { parse_mode: "HTML" });
        return;
      }

      if (p.status === "DELIVERED") {
        let codeText = "";
        try {
          const code = purchaseService.revealCode(p.id, "telegram");
          codeText = `\n\nCode: <tg-spoiler>${code}</tg-spoiler>`;
        } catch {}

        await bot.api.sendMessage(
          ownerChatId,
          `🎉 <b>Order Delivered!</b>\n\n` +
            `<b>${p.productName}</b> (${p.faceCurrency} ${p.faceValue})\n` +
            (p.settlement === "bitrefill-test-product"
              ? `<i>Demo: Bitrefill's test product was delivered in place of this item (no real money spent).</i>\n`
              : p.settlement === "bitrefill-store-credit"
                ? `<i>Real Bitrefill order, paid by the Shroud desk from store credit.</i>\n`
                : "") +
            `Cost: <b>${p.priceUsd}</b> ≈ ${formatZecPrice(p)}\n` +
            `Status: <b>DELIVERED</b>` +
            codeText,
          { parse_mode: "HTML" }
        );
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message, purchaseId: p.id },
        "Failed to send Telegram delivery notification"
      );
    }
  });
}
