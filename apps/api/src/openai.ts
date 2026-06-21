import OpenAI from "openai";
import { z } from "zod";

export type GenerateInput<T> = {
  name: string;
  schema: z.ZodType<T>;
  instructions: string;
  payload: unknown;
};

export interface Generator {
  generate<T>(input: GenerateInput<T>): Promise<T>;
}

// Per-request cap so a hung provider fails with a clear error instead of
// holding the Express request (and the extension popup) open indefinitely.
export const LLM_TIMEOUT_MS = 120_000;

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const definition = schema._def;
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = definition.shape();
    const properties = Object.fromEntries(
      Object.entries(shape).map(([key, value]) => [key, zodToJsonSchema(value as z.ZodTypeAny)])
    );
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodArray) {
    return { type: "array", items: zodToJsonSchema(definition.type) };
  }
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodString) return { type: "string" };
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodNumber) return { type: "number" };
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodBoolean) return { type: "boolean" };
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodEnum) {
    return { type: "string", enum: definition.values };
  }
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodOptional) {
    return zodToJsonSchema(definition.innerType);
  }
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
    return zodToJsonSchema(definition.innerType);
  }
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
    return { anyOf: [zodToJsonSchema(definition.innerType), { type: "null" }] };
  }
  throw new Error(`Unsupported schema type: ${definition.typeName}`);
}

export class OpenAIGenerator implements Generator {
  private client: OpenAI;
  private model: string;

  constructor(apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || "gpt-5.5") {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async generate<T>({ name, schema, instructions, payload }: GenerateInput<T>): Promise<T> {
    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      reasoning: { effort: "low" },
      instructions,
      input: JSON.stringify(payload),
      text: {
        format: {
          type: "json_schema",
          name,
          strict: true,
          schema: zodToJsonSchema(schema)
        }
      }
    }, { timeout: LLM_TIMEOUT_MS });
    return schema.parse(JSON.parse(response.output_text));
  }
}
