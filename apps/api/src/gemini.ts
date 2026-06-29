import OpenAI from "openai";
import type { GenerateInput, Generator } from "./openai.js";
import { LLM_TIMEOUT_MS, normalizeStructuredOutput, zodToJsonSchema } from "./openai.js";

// Gemini's OpenAI-compatible endpoint uses Chat Completions (not Responses API).
export class GeminiGenerator implements Generator {
  lastUsage?: { inputTokens?: number; outputTokens?: number };
  private client: OpenAI;
  private model: string;

  constructor(apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || "gemini-2.5-flash") {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
    });
    this.model = model;
  }

  async generate<T>({ name, schema, instructions, payload }: GenerateInput<T>): Promise<T> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(payload) }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name,
          strict: true,
          schema: zodToJsonSchema(schema)
        }
      }
    }, { timeout: LLM_TIMEOUT_MS });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("Gemini returned empty response");
    this.lastUsage = {
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens
    };
    return schema.parse(normalizeStructuredOutput(name, JSON.parse(text)));
  }
}
