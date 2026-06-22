import { describe, expect, it, vi } from "vitest";
import type { BaseProfile, JobDescription, TailoredCv } from "@cv-tailor/shared";
import type { Generator } from "./openai";
import { mergeReviewedExperienceTitles, reviewExperienceTitles } from "./titleReview";

const now = "2026-06-23T00:00:00.000Z";
const job: JobDescription = {
  title: "Backend Engineer",
  company: "Target",
  location: "",
  description: "Build backend services and APIs for a growing software platform.",
  url: "",
  source: "manual"
};
const profile: BaseProfile = {
  id: "profile-1",
  contact: { name: "Candidate", email: "", phone: "", location: "", linkedIn: "" },
  targetRole: "Software Developer",
  outputLanguage: "en",
  summary: "",
  experiences: [
    {
      id: "source-1",
      company: "Acme",
      role: "Software Developer",
      startDate: "2022",
      endDate: "2024",
      bullets: ["Built Node.js APIs and database integrations."]
    },
    {
      id: "source-2",
      company: "Studio",
      role: "UX Designer",
      startDate: "2020",
      endDate: "2022",
      bullets: ["Designed product workflows and maintained a design system."]
    }
  ],
  education: [],
  skills: ["Node.js", "API design"],
  skillCategories: {},
  certifications: [],
  languages: [],
  sectionOrder: [],
  style: { preset: "modern" },
  dismissedChecks: [],
  rawText: "",
  updatedAt: now
};
const cv: TailoredCv = {
  id: "cv-1",
  baseProfileId: profile.id,
  job,
  outputLanguage: "en",
  contact: profile.contact,
  summary: "",
  experiences: [
    {
      id: "tailored-1",
      company: "Acme",
      role: "Software Developer",
      startDate: "2022",
      endDate: "2024",
      bullets: ["Built Node.js APIs."],
      sourceExperienceId: "source-1",
      sourceBulletIndexes: [0]
    },
    {
      id: "tailored-2",
      company: "Studio",
      role: "UX Designer",
      startDate: "2020",
      endDate: "2022",
      bullets: ["Designed product workflows."],
      sourceExperienceId: "source-2",
      sourceBulletIndexes: [0]
    }
  ],
  education: [],
  skills: [],
  skillCategories: {},
  certifications: [],
  languages: [],
  sectionOrder: [],
  style: { preset: "modern" },
  dismissedChecks: [],
  unsupportedClaims: [],
  createdAt: now,
  updatedAt: now
};

describe("experience title review", () => {
  it("merges supported replacements and ignores unsafe response shapes", () => {
    const result = mergeReviewedExperienceTitles(cv, [
      { sourceExperienceId: "source-1", title: "Backend Developer" },
      { sourceExperienceId: "source-2", title: "Product Designer" },
      { sourceExperienceId: "source-2", title: "Design Director" },
      { sourceExperienceId: "unknown", title: "Unknown" },
      { sourceExperienceId: "", title: "Blank ID" },
      { sourceExperienceId: "missing-title", title: "   " }
    ], new Set(["source-1", "source-2"]));

    expect(result.experiences.map((experience) => experience.role)).toEqual([
      "Backend Developer",
      "UX Designer"
    ]);
  });

  it("reviews only the requested tailored experience", async () => {
    const generate = vi.fn(async (_input: unknown) => ({
      titles: [{ sourceExperienceId: "source-2", title: "Product Designer" }]
    }));
    const result = await reviewExperienceTitles(
      { generate: generate as Generator["generate"] },
      profile,
      job,
      cv,
      new Set(["source-2"])
    );

    expect(generate).toHaveBeenCalledOnce();
    const call = generate.mock.calls[0]?.[0] as unknown as { payload: { experiences: Array<{ sourceExperienceId: string }> } };
    expect(call.payload.experiences.map((experience) => experience.sourceExperienceId)).toEqual(["source-2"]);
    expect(result.experiences.map((experience) => experience.role)).toEqual([
      "Software Developer",
      "Product Designer"
    ]);
  });

  it("preserves existing titles when review or generator creation fails", async () => {
    const result = await reviewExperienceTitles(
      () => { throw new Error("provider unavailable"); },
      profile,
      job,
      cv
    );
    expect(result).toBe(cv);
  });

  it("does not call the generator when there are no eligible experiences", async () => {
    const generate = vi.fn();
    const result = await reviewExperienceTitles(
      { generate } as unknown as Generator,
      { ...profile, experiences: [] },
      job,
      { ...cv, experiences: [] }
    );
    expect(generate).not.toHaveBeenCalled();
    expect(result.experiences).toEqual([]);
  });
});
