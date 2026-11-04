import { OpenAiLlmClient, ToolDef } from "../src/agent/llm.js";
import { getEnv } from "../src/config/env.js";

async function main() {
  console.log("=== SMOKE TEST: LLM (Groq / OpenAI-compatible via LlmClient) ===");
  const env = getEnv();

  if (!env.LLM_API_KEY) {
    console.warn("LLM_API_KEY not configured. Skipping live LLM smoke test.");
    return;
  }

  const client = new OpenAiLlmClient();
  console.log(`Connecting to ${env.LLM_BASE_URL} using model: ${env.LLM_MODEL}`);

  const tools: ToolDef[] = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a given location",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "The city name, e.g. Mumbai, Berlin"
            }
          },
          required: ["location"]
        }
      }
    }
  ];

  const res = await client.chat(
    [
      {
        role: "system",
        content: "You are a helpful assistant. If the user asks for weather, use the get_weather tool."
      },
      {
        role: "user",
        content: "What is the weather in Mumbai right now?"
      }
    ],
    tools
  );

  console.log("LLM Response received:");
  console.log(" - Content:", res.content || "(No text, tool calls issued)");
  console.log(" - Tool calls:", JSON.stringify(res.toolCalls, null, 2));

  console.log("=== LLM SMOKE TEST FINISHED SUCCESSFULLY ===");
}

main().catch((err) => {
  console.error("Error in smoke:llm:", err);
  process.exit(1);
});
