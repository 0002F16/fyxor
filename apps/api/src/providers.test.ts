import { describe, expect, it } from "vitest";
import { createGenerator, providerStatus, resolveProvider } from "./providers";

describe("AI provider selection", () => {
  it("always resolves to the DeepSeek API", () => {
    expect(resolveProvider(undefined)).toBe("deepseek-api");
    expect(resolveProvider("unexpected")).toBe("deepseek-api");
  });

  it("normalizes older provider choices to DeepSeek", () => {
    expect(resolveProvider("openai-api")).toBe("deepseek-api");
    expect(resolveProvider("codex-local")).toBe("deepseek-api");
    expect(resolveProvider("gemini-api")).toBe("deepseek-api");
    expect(resolveProvider("groq-api")).toBe("deepseek-api");
  });

  it("reports DeepSeek configuration status", () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    const previousModel = process.env.DEEPSEEK_MODEL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_MODEL = "deepseek-test";
    expect(providerStatus(resolveProvider("groq-api"))).toEqual({
      provider: "deepseek-api",
      configured: false,
      model: "deepseek-test"
    });
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = previousModel;
  });

  it("fails clearly when the DeepSeek API key is missing", () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => createGenerator(resolveProvider("gemini-api"))).toThrow("DEEPSEEK_API_KEY is not configured");
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });
});
