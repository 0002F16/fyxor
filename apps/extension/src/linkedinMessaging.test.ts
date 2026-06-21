import { afterEach, describe, expect, it, vi } from "vitest";
import { sendLinkedInMessage } from "./linkedinMessaging";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LinkedIn popup reconnection", () => {
  it("injects the content loader and retries when an existing tab has no receiver", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce({ status: "ready" });
    const executeScript = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { tabs: { sendMessage }, scripting: { executeScript } });

    const result = sendLinkedInMessage<{ status: string }>(42, { type: "CV_TAILOR_SCAN_LINKEDIN" });
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({ status: "ready" });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ["content-loader.js"] });
  });
});
