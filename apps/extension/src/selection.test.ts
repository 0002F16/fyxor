import { describe, expect, it } from "vitest";
import { jobFromSelection } from "./selection";

describe("selected text handoff", () => {
  it("creates a manual job from browser context", () => {
    expect(jobFromSelection("  Product manager role requirements  ", "https://jobs.example.com/123", "Senior Product Manager")).toEqual({
      title: "Senior Product Manager",
      company: "jobs.example.com",
      location: "",
      description: "Product manager role requirements",
      url: "https://jobs.example.com/123",
      source: "manual"
    });
  });

  it("strips the trailing | LinkedIn suffix from a real job title", () => {
    expect(jobFromSelection("desc", "https://www.linkedin.com/jobs/view/123", "FP&A Analyst | Aon | LinkedIn").title).toBe("FP&A Analyst");
  });

  it("drops a generic feed title instead of using it as the job title", () => {
    expect(jobFromSelection("desc", "https://www.linkedin.com/feed/", "Jobs where you'd be a top applicant | LinkedIn").title).toBe("");
  });

  it("drops the title on a jobs collection/search surface", () => {
    expect(jobFromSelection("desc", "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=1", "Top job picks for you | LinkedIn").title).toBe("");
  });
});
