import { describe, expect, it } from "vitest";
import { nextScanDelay, shouldAcceptScan } from "./scanLifecycle";

describe("LinkedIn scan lifecycle", () => {
  it("rejects a result when the selected job or generation changes", () => {
    expect(shouldAcceptScan("1", "1", 2, 2)).toBe(true);
    expect(shouldAcceptScan("1", "2", 2, 2)).toBe(false);
    expect(shouldAcceptScan("1", "1", 1, 2)).toBe(false);
  });

  it("backs off retries without stopping them", () => {
    expect(nextScanDelay(1)).toBe(450);
    expect(nextScanDelay(20)).toBe(1200);
  });
});
