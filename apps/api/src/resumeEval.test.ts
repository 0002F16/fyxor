import { describe, expect, it } from "vitest";
import type { BaseProfile, JobDescription, TailoredCv } from "@cv-tailor/shared";
import { evaluateTailoredCv } from "./resumeEval";

const profile: BaseProfile = {
  id: "profile-1",
  contact: { name: "Jane Doe", email: "jane@example.com", phone: "", location: "Manila", linkedIn: "" },
  targetRole: "Backend Engineer",
  outputLanguage: "en",
  summary: "Software developer focused on reliable APIs.",
  experiences: [{
    id: "source-1",
    company: "Acme",
    role: "Software Developer",
    startDate: "2022",
    endDate: "Present",
    bullets: [
      "Built TypeScript APIs used by 12 internal teams.",
      "Reduced deployment time by 25% through CI automation."
    ]
  }],
  education: [],
  skills: ["TypeScript", "API Design", "CI/CD"],
  skillCategories: { Engineering: ["TypeScript", "API Design", "CI/CD"] },
  certifications: [],
  languages: [],
  sectionOrder: [],
  style: { preset: "modern" },
  dismissedChecks: [],
  rawText: "Software Developer at Acme. Built TypeScript APIs used by 12 internal teams. Reduced deployment time by 25% through CI automation.",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const job: JobDescription = {
  title: "Backend Engineer",
  company: "Example",
  location: "",
  description: "Build TypeScript services and apply API Design and CI/CD practices across the platform.",
  url: "",
  source: "manual"
};

function tailored(overrides: Partial<TailoredCv> = {}): TailoredCv {
  return {
    id: "cv-1",
    baseProfileId: profile.id,
    job,
    outputLanguage: "en",
    contact: profile.contact,
    summary: "Software developer bringing reliable TypeScript API delivery and CI/CD experience to a backend engineering team.",
    experiences: [{
      id: "tailored-1",
      company: "Acme",
      role: "Software Developer",
      startDate: "2022",
      endDate: "Present",
      bullets: [
        "Built TypeScript APIs used by 12 internal teams, strengthening reliable service delivery.",
        "Reduced deployment time by 25% through CI automation and repeatable release practices."
      ],
      sourceExperienceId: "source-1",
      sourceBulletIndexes: [0, 1]
    }],
    education: [],
    skills: ["TypeScript", "API Design", "CI/CD"],
    skillCategories: { Engineering: ["TypeScript", "API Design", "CI/CD"] },
    certifications: [],
    languages: [],
    sectionOrder: [],
    style: { preset: "modern" },
    dismissedChecks: [],
    unsupportedClaims: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("evaluateTailoredCv", () => {
  it("passes source linkage, citations, facts, and numeric grounding for a supported rewrite", () => {
    const result = evaluateTailoredCv(profile, job, tailored());
    expect(result.hardFailures).toEqual([]);
    expect(result.checks.find((item) => item.id === "supported-job-skill-coverage")?.status).toBe("pass");
  });

  it("fails empty source citations and invented numeric claims", () => {
    const cv = tailored({
      summary: "Improved platform reliability by 40%.",
      experiences: [{ ...tailored().experiences[0]!, sourceBulletIndexes: [] }]
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.hardFailures.map((item) => item.id)).toEqual(expect.arrayContaining([
      "bullet-citations",
      "unsupported-numbers"
    ]));
  });

  it("fails changed employers or dates", () => {
    const cv = tailored({
      experiences: [{ ...tailored().experiences[0]!, company: "Different Co", startDate: "2021" }]
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.hardFailures.map((item) => item.id)).toContain("fact-preservation");
  });

  it("warns on unsupported skills and changed titles", () => {
    const cv = tailored({
      skills: [...tailored().skills, "Kubernetes"],
      experiences: [{ ...tailored().experiences[0]!, role: "Backend Engineer" }]
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.checks.find((item) => item.id === "skill-evidence")?.status).toBe("warn");
    expect(result.checks.find((item) => item.id === "title-reframing")?.status).toBe("warn");
  });
});
