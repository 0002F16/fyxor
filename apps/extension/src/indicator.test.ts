import { describe, expect, it } from "vitest";
import type { JobDescription } from "@cv-tailor/shared";
import { indicatorCopy } from "./indicator";

const job: JobDescription = {
  title: "Senior Product Manager",
  company: "Example Labs",
  location: "Warsaw",
  description: "A sufficiently long description for the current LinkedIn job listing.",
  url: "https://www.linkedin.com/jobs/view/1",
  source: "linkedin"
};

describe("LinkedIn page indicator", () => {
  it("shows active scanning state", () => {
    expect(indicatorCopy("scanning")).toEqual({
      label: "Fyxor active",
      detail: "Reading this page…",
      tone: "scanning"
    });
  });

  it("shows the detected job title", () => {
    expect(indicatorCopy("detected", job)).toEqual({
      label: "Tailor CV",
      detail: "Senior Product Manager",
      tone: "detected"
    });
  });

  it("does not tell users to open a job when a LinkedIn job id is selected", () => {
    expect(indicatorCopy("job-selected")).toEqual({
      label: "Fyxor",
      detail: "Reading job details…",
      tone: "scanning"
    });
  });
});
