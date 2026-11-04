import { getEnv } from "../config/env.js";
import { MerchantAdapter } from "../merchant/types.js";
import { PurchaseService } from "../router/purchase-service.js";
import { logger } from "../shared/logger.js";
import { ChatMessage, LlmClient } from "./llm.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { AGENT_TOOLS, ToolExecutor } from "./tools.js";

/** Phrases that assert a purchase happened (or is happening right now). */
/**
 * Affirmative claims that a purchase happened or is under way ("Buying X now",
 * "I've ordered…", "I'll message you when it's delivered"). Negative or blocked replies
 * ("can't proceed with buying", "spending is paused") must NOT match: an earlier, broader
 * pattern replaced correct explanations with a generic message.
 */
const AFFIRMS_PURCHASE =
  /(\bi'?ll message you when it'?s delivered\b|\b(buying|ordering)\b(?:[^.!?]|\.(?=\d))*\bnow\b|\bi(?:'ve| have)? (?:just )?(?:bought|purchased|ordered|placed (?:the|your) order)\b|\byour order (?:is|has been) placed\b)/i;
const NEGATES_PURCHASE =
  /\b(can'?t|cannot|can not|won'?t|unable|not|no purchase|nothing|haven'?t|hasn'?t|paused|blocked|denied|declined|refused|over your|exceeds?)\b/i;

export function claimsPurchase(reply: string): boolean {
  return AFFIRMS_PURCHASE.test(reply) && !NEGATES_PURCHASE.test(reply);
}

export interface AgentLoopOptions {
  llm: LlmClient;
  merchant: MerchantAdapter;
  purchaseService: PurchaseService;
  maxSteps?: number;
  historyTurns?: number;
}

export interface AgentResult {
  reply: string;
  purchaseIds: string[];
}

export class AgentSession {
  private history: ChatMessage[] = [];
  private readonly maxSteps: number;
  private readonly historyTurns: number;

  constructor(private readonly opts: AgentLoopOptions) {
    const env = getEnv();
    this.maxSteps = opts.maxSteps ?? env.LLM_MAX_STEPS ?? 10;
    this.historyTurns = opts.historyTurns ?? env.AGENT_HISTORY_TURNS ?? 10;
  }

  reset(): void {
    this.history = [];
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  async run(userText: string): Promise<AgentResult> {
    const createdPurchaseIds: string[] = [];
    const toolExec = new ToolExecutor({
      merchant: this.opts.merchant,
      purchaseService: this.opts.purchaseService,
      createdPurchaseIds
    });

    const recentHistory = this.history.slice(-this.historyTurns * 2);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...recentHistory,
      { role: "user", content: userText }
    ];

    let steps = 0;
    let correctedClaim = false;
    while (steps < this.maxSteps) {
      steps++;

      logger.debug({ step: steps, messagesCount: messages.length }, "Agent loop turn");
      // On the last step, withhold tools so the model must answer in text instead of
      // burning the step on another lookup (which left the owner with a generic error
      // even though the purchase had been created).
      const isLastStep = steps === this.maxSteps;
      // First step must be a tool call: prompt rules alone didn't stop the model asking
      // "which carrier?" before even searching. Looking at the catalog first means it
      // only asks when the real options are actually ambiguous.
      let turn: Awaited<ReturnType<LlmClient["chat"]>>;
      try {
        turn = await this.opts.llm.chat(
          messages,
          isLastStep ? [] : AGENT_TOOLS,
          { requireTool: steps === 1 && !isLastStep }
        );
      } catch (err: any) {
        // Once a purchase exists the owner must hear its real status, not a raw LLM error
        // (e.g. Groq 400 "tool_use_failed" when gpt-oss calls a tool on the no-tools turn).
        if (createdPurchaseIds.length === 0) throw err;
        logger.warn({ err: err.message }, "LLM failed after a purchase was created; using status reply");
        break;
      }

      // If the model produced tool calls, execute them and continue loop
      if (!isLastStep && turn.toolCalls && turn.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: turn.content,
          tool_calls: turn.toolCalls
        });

        for (const tc of turn.toolCalls) {
          logger.debug({ tool: tc.function.name, args: tc.function.arguments }, "Executing tool");
          const output = await toolExec.execute(tc.function.name, tc.function.arguments);

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(output)
          });
        }
      } else {
        // Last step but the model still only wanted tools: use the fallback below
        if (isLastStep && !turn.content) break;

        // Model returned final text reply
        let reply = turn.content || "I have processed your request.";

        // Honesty guard: the model once said "Buying … now" without calling request_purchase.
        if (createdPurchaseIds.length === 0 && claimsPurchase(reply)) {
          if (!isLastStep && !correctedClaim) {
            correctedClaim = true;
            messages.push({ role: "assistant", content: reply });
            messages.push({
              role: "user",
              content:
                "[system check] No purchase was created in this turn: request_purchase was not called or did not succeed. " +
                "Do not say anything was bought. Either call request_purchase now (only for exactly what the owner asked, " +
                "if get_quote allowed it) or tell the owner plainly that nothing has been bought yet and why."
            });
            continue;
          }
          reply = "I haven't bought anything yet. Tell me exactly what you'd like and I'll check it against your rules.";
        }

        // Append user turn and assistant reply to session history
        this.history.push({ role: "user", content: userText });
        this.history.push({ role: "assistant", content: reply });

        // Cap history length
        if (this.history.length > this.historyTurns * 2) {
          this.history = this.history.slice(-this.historyTurns * 2);
        }

        return {
          reply,
          purchaseIds: createdPurchaseIds
        };
      }
    }

    // Max steps exhausted without a text reply. If a purchase was created, report its
    // real status from the DB rather than implying nothing happened.
    const fallbackReply =
      createdPurchaseIds.length > 0
        ? this.describePurchases(createdPurchaseIds)
        : "Sorry, I couldn't finish that. Try rephrasing.";
    this.history.push({ role: "user", content: userText });
    this.history.push({ role: "assistant", content: fallbackReply });

    return {
      reply: fallbackReply,
      purchaseIds: createdPurchaseIds
    };
  }

  private describePurchases(ids: string[]): string {
    return ids
      .map((id) => {
        const p = this.opts.purchaseService.get(id);
        switch (p.status) {
          case "AWAITING_APPROVAL":
            return `${p.productName} (${p.priceUsd}) needs your approval, tap Approve above.`;
          case "DENIED":
            return `${p.productName} (${p.priceUsd}) was blocked by your rules: ${p.policyReasons[0] ?? "policy limit"}.`;
          default:
            return `Buying ${p.productName} (${p.priceUsd}) now, I'll message you when it's delivered.`;
        }
      })
      .join("\n");
  }
}

