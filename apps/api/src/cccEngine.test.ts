import { describe, expect, it } from "vitest";
import type { BaseProfile, JobDescription } from "@cv-tailor/shared";
import { mapResumeToTailoredCv } from "./cccEngine";

const now = "2026-06-23T00:00:00.000Z";
const profile: BaseProfile = {
  id: "profile-1",
  contact: { name: "Candidate", email: "", phone: "", location: "", linkedIn: "" },
  targetRole: "",
  outputLanguage: "en",
  summary: "",
  experiences: [
    { id: "source-1", company: "Acme", role: "Software Developer", startDate: "Jan 2022", endDate: "Dec 2024", bullets: ["Built APIs."] },
    { id: "source-2", company: "Studio", role: "UX Designer", startDate: "2020", endDate: "2021", bullets: ["Designed workflows."] }
  ],
  education: [],
  skills: [],
  skillCategories: {},
  certifications: [],
  languages: [],
  sectionOrder: [],
  style: { preset: "modern" },
  dismissedChecks: [],
  rawText: "",
  updatedAt: now
};
const job: JobDescription = {
  title: "Backend Developer",
  company: "Target",
  location: "",
  description: "A sufficiently detailed backend developer job description.",
  url: "",
  source: "manual"
};

describe("CCC resume mapping", () => {
  it("retains source IDs when CCC reframes generated titles", () => {
    const cv = mapResumeToTailoredCv({
      experience: [
        { title: "Backend Developer", company: "Acme", dates: "Jan 2022 – Dec 2024", bullets: ["Built APIs."] },
        { title: "Product Designer", company: "Studio", dates: "2020 – 2021", bullets: ["Designed workflows."] }
      ]
    }, profile, job);

    expect(cv.experiences.map((experience) => experience.sourceExperienceId)).toEqual([
      "source-1",
      "source-2"
    ]);
  });

  it("uses each positional source at most once when stronger matches are unavailable", () => {
    const cv = mapResumeToTailoredCv({
      experience: [
        { title: "Reframed One", company: "", dates: "", bullets: [] },
        { title: "Reframed Two", company: "", dates: "", bullets: [] }
      ]
    }, profile, job);

    expect(cv.experiences.map((experience) => experience.sourceExperienceId)).toEqual([
      "source-1",
      "source-2"
    ]);
  });
});
