import OpenAI from "openai";
import { z } from "zod";

export type GenerateInput<T> = {
  name: string;
  schema: z.ZodType<T>;
  instructions: string;
  payload: unknown;
};

export interface Generator {
  lastUsage?: { inputTokens?: number; outputTokens?: number };
  generate<T>(input: GenerateInput<T>): Promise<T>;
}

// Per-request cap so a hung provider fails with a clear error instead of
// holding the Express request (and the extension popup) open indefinitely.
export const LLM_TIMEOUT_MS = 120_000;

export function normalizeStructuredOutput(name: string, value: unknown): unknown {
  if (name !== "evidence_plan" || !value || typeof value !== "object") return value;
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.requirements)) return value;
  plan.requirements = plan.requirements.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const requirement = { ...(entry as Record<string, unknown>) };
    const importance = typeof requirement.hiringImportance === "number"
      ? Math.max(1, Math.min(5, Math.round(requirement.hiringImportance)))
      : 3;
    requirement.hiringImportance = importance;
    requirement.summaryValue = typeof requirement.summaryValue === "number"
      ? Math.max(1, Math.min(5, Math.round(requirement.summaryValue)))
      : Math.min(5, importance);
    requirement.priority = ["must", "important", "supporting"].includes(String(requirement.priority))
      ? requirement.priority
      : importance >= 5 ? "must" : importance >= 3 ? "important" : "supporting";
    const typeAliases: Record<string, string> = {
      skill: "competency",
      general: "competency",
      experience: "function",
      years_experience: "seniority",
      work_authorization: "authorization",
      credential: "certification",
      cert: "certification"
    };
    const type = typeAliases[String(requirement.type)] || requirement.type;
    requirement.type = [
      "function", "industry", "seniority", "language", "certification", "license",
      "tool", "education", "authorization", "competency", "other"
    ].includes(String(type)) ? type : "other";
    const coverageAliases: Record<string, string> = {
      supported: "supported-equivalent",
      partial: "supported-equivalent",
      inferred: "supported-equivalent",
      none: "unsupported"
    };
    const coverage = coverageAliases[String(requirement.coverage)] || requirement.coverage;
    requirement.coverage = ["explicit", "supported-equivalent", "unsupported"].includes(String(coverage))
      ? coverage
      : "unsupported";
    return requirement;
  });
  return plan;
}

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
  // z.preprocess / z.transform / z.refine — strip the effect and use the output schema
  if (definition.typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
    return zodToJsonSchema(definition.schema);
  }
  throw new Error(`Unsupported schema type: ${definition.typeName}`);
}

export class OpenAIGenerator implements Generator {
  lastUsage?: { inputTokens?: number; outputTokens?: number };
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
    this.lastUsage = {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    };
    return schema.parse(normalizeStructuredOutput(name, JSON.parse(response.output_text)));
  }
}
