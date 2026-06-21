import { describe, expect, it } from "vitest";
import { resolveProvider } from "./providers";

describe("AI provider selection", () => {
  it("defaults to the Gemini API", () => {
    expect(resolveProvider(undefined)).toBe("gemini-api");
    expect(resolveProvider("unexpected")).toBe("gemini-api");
  });

  it("allows fast switching to other providers", () => {
    expect(resolveProvider("openai-api")).toBe("openai-api");
    expect(resolveProvider("codex-local")).toBe("codex-local");
  });
});
