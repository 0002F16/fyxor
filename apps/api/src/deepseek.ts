import OpenAI from "openai";
import type { Generator, GenerateInput } from "./openai.js";
import { LLM_TIMEOUT_MS, normalizeStructuredOutput, zodToJsonSchema } from "./openai.js";

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1_500;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(error: unknown, attempt: number): number {
  const headers = (error as { headers?: Record<string, string> })?.headers || {};
  const header = headers["retry-after"] || headers["Retry-After"];
  const retryAfter = header ? Number(header) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exponential + Math.floor(Math.random() * 500);
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function isUnsupportedJsonSchema(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status !== 400 && status !== 422) return false;
  const message = String((error as { message?: string })?.message || "").toLowerCase();
  return message.includes("json_schema") || message.includes("response_format") || message.includes("json schema");
}

export class DeepSeekGenerator implements Generator {
  lastUsage?: { inputTokens?: number; outputTokens?: number };
  private client: OpenAI;
  private model: string;
  private useJsonObject = false;

  constructor(apiKey = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash") {
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com",
    });
    this.model = model;
  }

  private async call<T>({ name, schema, instructions, payload }: GenerateInput<T>, jsonObject: boolean) {
    const jsonSchema = zodToJsonSchema(schema);
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
            this.useJsonObject = true;
            response = await this.call(input, true);
          } else {
            throw error;
          }
        }

        const text = response.choices[0]?.message?.content;
        if (!text) throw new Error("DeepSeek returned an empty response");
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
