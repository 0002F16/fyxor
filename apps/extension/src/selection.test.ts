import { describe, expect, it } from "vitest";
import { jobFromSelection, parseJobFromText } from "./selection";

const BOSCH_BLOCK = `Bosch Philippines logo
Bosch Philippines
Share
Show more options
HR Intern
Taguig, National Capital Region, Philippines · 2 weeks ago · 94 people clicked apply
Promoted by hirer · Responses managed off LinkedIn
About the job
Company Description`;

describe("parseJobFromText", () => {
  it("pulls title, company, and location out of a LinkedIn block", () => {
    expect(parseJobFromText(BOSCH_BLOCK)).toEqual({
      title: "HR Intern",
      company: "Bosch Philippines",
      location: "Taguig, National Capital Region, Philippines"
    });
  });

  it("falls back to the title after 'Show more options' when there is no metadata row", () => {
    expect(parseJobFromText("Acme logo\nAcme\nShow more options\nStaff Engineer")).toEqual({
      title: "Staff Engineer",
      company: "Acme",
      location: ""
    });
  });

  it("returns empty values for an unstructured plain-text paste", () => {
    expect(parseJobFromText("We are looking for a great person to join our team.")).toEqual({
      title: "",
      company: "",
      location: ""
    });
  });

  it("never lets a generic feed phrase become the title", () => {
    expect(parseJobFromText("Jobs where you'd be a top applicant · 2 days ago").title).toBe("");
  });
});

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

  it("prefers title/company parsed from the selected text over the tab title and hostname", () => {
    const job = jobFromSelection(BOSCH_BLOCK, "https://www.linkedin.com/jobs/view/123", "Jobs where you'd be a top applicant | LinkedIn");
    expect(job.title).toBe("HR Intern");
    expect(job.company).toBe("Bosch Philippines");
    expect(job.location).toBe("Taguig, National Capital Region, Philippines");
  });
});
