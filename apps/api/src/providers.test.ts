import { describe, expect, it } from "vitest";
import { resolveProvider } from "./providers";

describe("AI provider selection", () => {
  it("defaults to the Groq API", () => {
    expect(resolveProvider(undefined)).toBe("groq-api");
    expect(resolveProvider("unexpected")).toBe("groq-api");
  });

  it("allows fast switching to other providers", () => {
    expect(resolveProvider("openai-api")).toBe("openai-api");
    expect(resolveProvider("codex-local")).toBe("codex-local");
    expect(resolveProvider("gemini-api")).toBe("gemini-api");
    expect(resolveProvider("groq-api")).toBe("groq-api");
  });
});
