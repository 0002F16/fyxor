import { describe, expect, it } from "vitest";
import { stageIndexAt, TAILOR_STAGES } from "./progress";

describe("stageIndexAt", () => {
  const interval = 6000;
  const count = TAILOR_STAGES.length;

  it("starts at the first stage", () => {
    expect(stageIndexAt(0, count, interval)).toBe(0);
    expect(stageIndexAt(interval - 1, count, interval)).toBe(0);
  });

  it("advances one stage per interval", () => {
    expect(stageIndexAt(interval, count, interval)).toBe(1);
    expect(stageIndexAt(interval * 2, count, interval)).toBe(2);
  });

  it("clamps at the final stage no matter how long it runs", () => {
    expect(stageIndexAt(interval * 99, count, interval)).toBe(count - 1);
  });

  it("never returns a negative index for odd inputs", () => {
    expect(stageIndexAt(-5000, count, interval)).toBe(0);
    expect(stageIndexAt(1000, 0, interval)).toBe(0);
  });
});
