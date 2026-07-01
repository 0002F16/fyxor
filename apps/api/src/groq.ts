import OpenAI from "openai";
import { z } from "zod";
import type { Generator, GenerateInput } from "./openai.js";
import { zodToJsonSchema, LLM_TIMEOUT_MS, normalizeStructuredOutput } from "./openai.js";

// Groq free-tier TPM limits (12K for llama-3.3-70b) are lower than a full
// tailoring run's per-minute token load (~27K across 5 sequential calls), so
// individual calls will intermittently 429. Retry with exponential backoff and
// honour any Retry-After header so a run spreads across the rolling budget
// instead of failing outright on the first rate-limit.
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1_500;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(error: unknown, attempt: number): number {
  const header = (error as { headers?: Record<string, string> })?.headers?.["retry-after"];
  const retryAfter = header ? Number(header) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exponential + Math.floor(Math.random() * 500); // jitter
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

// A 400 whose message names json_schema / response_format means the model does
// not support Groq structured outputs; fall back to json_object mode instead.
function isUnsupportedJsonSchema(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status !== 400) return false;
  const message = String((error as { message?: string })?.message || "").toLowerCase();
  return message.includes("json_schema") || message.includes("response_format") || message.includes("json schema");
}

export class GroqGenerator implements Generator {
  lastUsage?: { inputTokens?: number; outputTokens?: number };
  private client: OpenAI;
  private model: string;
  // Set once we learn the model rejects json_schema, so later calls in the same
  // run go straight to json_object mode instead of paying the failed attempt.
  private useJsonObject = false;

  constructor(apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct") {
    if (!apiKey) throw new Error("GROQ_API_KEY is not configured");
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
    this.model = model;
  }

  private async call<T>({ name, schema, instructions, payload }: GenerateInput<T>, jsonObject: boolean) {
    const jsonSchema = zodToJsonSchema(schema);
    // json_object mode isn't schema-enforced, so steer the model with the schema
    // in the system prompt (and satisfy Groq's requirement that "json" appears).
    const systemContent = jsonObject
      ? `${instructions}\n\nReturn ONLY a single JSON object that conforms to this JSON schema:\n${JSON.stringify(jsonSchema)}`
      : instructions;
    return this.client.chat.completions.create({
      model: this.model,
      response_format: jsonObject
        ? { type: "json_object" }
        : ({
            type: "json_schema",
            json_schema: { name, schema: jsonSchema, strict: false },
          } as Parameters<typeof this.client.chat.completions.create>[0]["response_format"]),
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }, { timeout: LLM_TIMEOUT_MS });
  }

  async generate<T>(input: GenerateInput<T>): Promise<T> {
    const { name, schema } = input;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let response;
        try {
          response = await this.call(input, this.useJsonObject);
        } catch (error) {
          if (!this.useJsonObject && isUnsupportedJsonSchema(error)) {
            // Model doesn't support json_schema; remember and retry in json_object mode.
            this.useJsonObject = true;
            response = await this.call(input, true);
          } else {
            throw error;
          }
        }

        const text = response.choices[0]?.message?.content;
        if (!text) throw new Error("Groq returned an empty response");
        this.lastUsage = {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens
        };
        return schema.parse(normalizeStructuredOutput(name, JSON.parse(text)));
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES && isRetryable(error)) {
          await sleep(retryDelayMs(error, attempt));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }
}
