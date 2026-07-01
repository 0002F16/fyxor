import type { AiProvider } from "@cv-tailor/shared";
import type { Generator } from "./openai.js";
import { DeepSeekGenerator } from "./deepseek.js";

export function resolveProvider(value: unknown): AiProvider {
  void value;
  return "deepseek-api";
}

export function createGenerator(provider: AiProvider): Generator {
  void provider;
  return new DeepSeekGenerator();
}

export function providerStatus(provider: AiProvider) {
  void provider;
  return {
    provider: "deepseek-api" as const,
    configured: Boolean(process.env.DEEPSEEK_API_KEY),
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"
  };
}
