import OpenAI from "openai";
import { getEnv } from "../config/env.js";
import { ShroudError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ChatOptions {
  /** Force the model to call a tool this turn (tool_choice: "required"). */
  requireTool?: boolean;
}

export interface LlmClient {
  chat(messages: ChatMessage[], tools: ToolDef[], opts?: ChatOptions): Promise<AssistantTurn>;
}

export interface OpenAiClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackBaseUrl?: string;
  fallbackApiKey?: string;
  fallbackModel?: string;
  timeoutMs?: number;
}

export class OpenAiLlmClient implements LlmClient {
  private readonly primary: OpenAI;
  private readonly primaryModel: string;
  private readonly fallback?: OpenAI;
  private readonly fallbackModel?: string;
  private readonly timeoutMs: number;

  constructor(cfg?: Partial<OpenAiClientConfig>) {
    const env = getEnv();
    const baseUrl = cfg?.baseUrl ?? env.LLM_BASE_URL;
    const apiKey = cfg?.apiKey ?? env.LLM_API_KEY;
    this.primaryModel = cfg?.model ?? env.LLM_MODEL;
    this.timeoutMs = cfg?.timeoutMs ?? 30_000;

    // Groq's free tier limits tokens per minute; one agent turn can use most of it, so
    // retry with backoff before giving up (the SDK honours Retry-After).
    this.primary = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "dummy-key",
      timeout: this.timeoutMs,
      maxRetries: 4
    });

    // A fallback model on the same provider has its own rate-limit bucket, so setting only
    // LLM_FALLBACK_MODEL is enough; base URL and key default to the primary's.
    // `||`, not `??`: boot passes unset env vars through as "", which must still default.
    const fbBaseUrl = cfg?.fallbackBaseUrl || env.LLM_FALLBACK_BASE_URL || baseUrl;
    const fbApiKey = cfg?.fallbackApiKey || env.LLM_FALLBACK_API_KEY || apiKey;
    const fbModel = cfg?.fallbackModel || env.LLM_FALLBACK_MODEL;

    if (fbBaseUrl && fbApiKey && fbModel) {
      this.fallback = new OpenAI({
        baseURL: fbBaseUrl,
        apiKey: fbApiKey,
        timeout: this.timeoutMs,
        maxRetries: 2
      });
      this.fallbackModel = fbModel;
    }
  }

  async chat(messages: ChatMessage[], tools: ToolDef[], opts?: ChatOptions): Promise<AssistantTurn> {
    try {
      try {
        return await this.callClient(this.primary, this.primaryModel, messages, tools, opts);
      } catch (err: any) {
        // Groq rejects (400 tool_use_failed) when tool_choice is "required" but the model
        // answers in text (e.g. a plain "hi"). Forcing a tool is only a nudge, so retry freely.
        if (opts?.requireTool && err.code === "tool_use_failed") {
          return await this.callClient(this.primary, this.primaryModel, messages, tools);
        }
        throw err;
      }
    } catch (err: any) {
      const isRetryable =
        err.status === 429 ||
        (err.status && err.status >= 500) ||
        err.code === "ETIMEDOUT" ||
        err.message?.includes("timeout");

      if (this.fallback && isRetryable) {
        logger.warn(
          { err: err.message, status: err.status },
          "Primary LLM failed, switching to fallback provider"
        );
        return await this.callClient(
          this.fallback,
          this.fallbackModel!,
          messages,
          tools,
          opts
        );
      }

      throw new ShroudError("LLM_ERROR", `LLM chat completion failed: ${err.message}`, {
        status: err.status,
        code: err.code
      });
    }
  }

  private async callClient(
    client: OpenAI,
    model: string,
    messages: ChatMessage[],
    tools: ToolDef[],
    opts?: ChatOptions
  ): Promise<AssistantTurn> {
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model,
      messages: messages as any,
      temperature: 0.2,
      tools: tools.length > 0 ? (tools as any) : undefined,
      tool_choice: tools.length > 0 ? (opts?.requireTool ? "required" : "auto") : undefined,
      parallel_tool_calls: false
    };

    const completion = await client.chat.completions.create(params);
    const choice = completion.choices[0];
    if (!choice) {
      throw new ShroudError("LLM_ERROR", "LLM returned no response choices");
    }

    if (completion.usage) {
      logger.debug(
        {
          model,
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens
        },
        "LLM token usage"
      );
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments
      }
    }));

    return {
      content: choice.message.content || null,
      toolCalls
    };
  }
}

