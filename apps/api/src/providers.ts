import type { AiProvider } from "@cv-tailor/shared";
import type { Generator } from "./openai.js";
import { OpenAIGenerator } from "./openai.js";
import { GeminiGenerator } from "./gemini.js";
import { CodexGenerator } from "./codex.js";

export function resolveProvider(value: unknown): AiProvider {
  if (value === "openai-api") return "openai-api";
  if (value === "codex-local") return "codex-local";
  return "gemini-api";
}

export function createGenerator(provider: AiProvider): Generator {
  if (provider === "openai-api") return new OpenAIGenerator();
  if (provider === "gemini-api") return new GeminiGenerator();
  return new CodexGenerator();
}

export function providerStatus(provider: AiProvider) {
  if (provider === "openai-api") {
    return { provider, configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_MODEL || "gpt-5.5" };
  }
  if (provider === "gemini-api") {
    return { provider, configured: Boolean(process.env.GEMINI_API_KEY), model: process.env.GEMINI_MODEL || "gemini-2.5-flash" };
  }
  return { provider, configured: true, model: process.env.CODEX_MODEL || "Codex CLI default" };
}
