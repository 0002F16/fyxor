import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { JobDescription } from "@cv-tailor/shared";
import { dialogJobSummary } from "./dialog";

describe("compact LinkedIn dialog", () => {
  it("waits until job details are ready", () => {
    expect(dialogJobSummary(null)).toEqual({
      title: "Waiting for job details",
      company: "LinkedIn",
      ready: false
    });
  });

  it("summarizes a detected job", () => {
    const job: JobDescription = {
      title: "Product Manager",
      company: "Example Labs",
      location: "Warsaw",
      description: "A sufficiently long job description for tailoring the candidate CV.",
      url: "https://www.linkedin.com/jobs/view/1",
      source: "linkedin"
    };
    expect(dialogJobSummary(job)).toEqual({
      title: "Product Manager",
      company: "Example Labs",
      ready: true
    });
  });

  it("shows an actionable unsupported-layout state instead of indefinite waiting", () => {
    const source = readFileSync("apps/extension/src/dialog.ts", "utf8");
    expect(source).toContain("Unable to read this LinkedIn layout");
    expect(source).toContain("Retry detection");
    expect(source).not.toContain("waiting for LinkedIn");
  });
});
