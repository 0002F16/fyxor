import OpenAI from "openai";
import { z } from "zod";
import type { Generator, GenerateInput } from "./openai.js";
import { zodToJsonSchema, LLM_TIMEOUT_MS } from "./openai.js";

export class GroqGenerator implements Generator {
  private client: OpenAI;
  private model: string;

  constructor(apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct") {
    if (!apiKey) throw new Error("GROQ_API_KEY is not configured");
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
    this.model = model;
  }

  async generate<T>({ name, schema, instructions, payload }: GenerateInput<T>): Promise<T> {
    const jsonSchema = zodToJsonSchema(schema);
    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: {
        type: "json_schema",
        json_schema: { name, schema: jsonSchema, strict: false },
      } as Parameters<typeof this.client.chat.completions.create>[0]["response_format"],
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }, { timeout: LLM_TIMEOUT_MS });

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("Groq returned an empty response");
    return schema.parse(JSON.parse(text));
  }
}
