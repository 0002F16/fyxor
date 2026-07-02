import { describe, expect, it } from "vitest";
import type { BaseProfile, JobDescription, TailoredCv } from "@cv-tailor/shared";
import { evaluateTailoredCv } from "./resumeEval";

const profile: BaseProfile = {
  id: "profile-1",
  contact: { name: "Jane Doe", email: "jane@example.com", phone: "", location: "Manila", linkedIn: "" },
  targetRole: "Backend Engineer",
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
    contact: profile.contact,
    summary: "Software developer bringing reliable TypeScript API delivery and CI/CD experience to a backend engineering team.",
    summaryClaims: [{
      id: "claim-1",
      text: "TypeScript API delivery and CI/CD experience",
      evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0, 1] }],
      evidenceStatus: "verified"
    }],
    experiences: [{
      id: "tailored-1",
      company: "Acme",
      role: "Software Developer",
      startDate: "2022",
      endDate: "Present",
      bullets: [
        { id: "b1", text: "Built TypeScript APIs used by 12 internal teams, strengthening reliable service delivery.", sourceBulletIndexes: [0], evidenceStatus: "verified" },
        { id: "b2", text: "Reduced deployment time by 25% through CI automation and repeatable release practices.", sourceBulletIndexes: [1], evidenceStatus: "verified" }
      ],
      sourceExperienceId: "source-1",
      originalRole: "Software Developer",
      titleEvidenceStatus: "unchanged",
      sourceBulletIndexes: [0, 1]
    }],
    education: [],
    skills: ["TypeScript", "API Design", "CI/CD"],
    skillEvidence: ["TypeScript", "API Design", "CI/CD"].map((skill) => ({
      skill,
      evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
      evidenceStatus: "verified" as const,
      provenance: "explicit" as const,
      sourceSkills: [skill],
      requirementIds: []
    })),
    skillCategories: { Engineering: ["TypeScript", "API Design", "CI/CD"] },
    certifications: [],
    languages: [],
    projects: [],
    sectionOrder: [],
    style: { preset: "modern" },
    dismissedChecks: [],
    unsupportedClaims: [],
    pipeline: { pipelineVersion: "test", runId: "", provider: "", model: "", stages: [], aiCallCount: 0, repairCount: 0 },
    readiness: "ready",
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
      experiences: [{
        ...tailored().experiences[0]!,
        bullets: tailored().experiences[0]!.bullets.map((bullet) => ({ ...bullet, sourceBulletIndexes: [] })),
        sourceBulletIndexes: []
      }]
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

  it("warns but does not block export for an approved inferred baseline skill", () => {
    const cv = tailored({
      skills: [...tailored().skills, "Communication"],
      skillEvidence: [
        ...tailored().skillEvidence,
        {
          skill: "Communication",
          evidence: [],
          evidenceStatus: "needs-review",
          provenance: "inferred-baseline",
          sourceSkills: [],
          requirementIds: []
        }
      ]
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.checks.find((item) => item.id === "inferred-skill-review")?.status).toBe("warn");
    expect(result.hardFailures).toEqual([]);
  });

  it("warns but does not block export for high-confidence inferred summary context", () => {
    const cv = tailored({
      summary: "Software developer with TypeScript API delivery experience in a healthcare technology context.",
      summaryClaims: [{
        id: "claim-inference",
        text: "healthcare technology context",
        evidence: [{
          kind: "inference",
          value: "healthcare technology context",
          basis: "Employer name and target industry",
          confidence: "high"
        }],
        provenance: "inferred-context",
        evidenceStatus: "needs-review"
      }]
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.checks.find((item) => item.id === "summary-inference-review")?.status).toBe("warn");
    expect(result.hardFailures).toEqual([]);
  });

  it("fails unsupported or inflated summary YoE claims", () => {
    const cv = tailored({
      summary: "Backend Engineer with 10 years of TypeScript API delivery and CI/CD experience for production platforms.",
      summaryClaims: [{
        id: "claim-1",
        text: "TypeScript API delivery and CI/CD experience",
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0, 1] }],
        evidenceStatus: "verified"
      }]
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.hardFailures.map((item) => item.id)).toContain("summary-yoe-support");
  });

  it("warns when JD-requested supported YoE is omitted", () => {
    const result = evaluateTailoredCv(profile, {
      ...job,
      description: `${job.description} Candidates should have 3 years of backend experience.`
    }, tailored());
    expect(result.checks.find((item) => item.id === "summary-yielded-yoe")?.status).toBe("warn");
  });

  it("warns on bloated, generic, or keyword-stuffed summaries", () => {
    const cv = tailored({
      summary: "Highly motivated, detail-oriented, results-driven Backend Engineer with excellent communication skills, TypeScript, API Design, CI/CD, cloud, databases, monitoring, testing, documentation, stakeholder management, delivery ownership, platform reliability, scalable services, incident response, observability, agile delivery, cross-functional collaboration, roadmap planning, technical documentation, troubleshooting, optimization, automation, and modern engineering team experience.",
      summaryClaims: [{
        id: "claim-1",
        text: "TypeScript API delivery and CI/CD experience",
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0, 1] }],
        evidenceStatus: "verified"
      }]
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.checks.find((item) => item.id === "summary-visual-compactness")?.status).toBe("warn");
    expect(result.checks.find((item) => item.id === "summary-generic-filler")?.status).toBe("warn");
    expect(result.checks.find((item) => item.id === "summary-keyword-stuffing")?.status).toBe("warn");
  });

  it("checks blueprint keyword coverage, proof density, and career-shift framing", () => {
    const cv = tailored({
      summary: "Backend Engineer with TypeScript delivery experience for production APIs.",
      summaryClaims: [{
        id: "claim-1",
        text: "TypeScript delivery experience",
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
        evidenceStatus: "verified"
      }],
      evidencePlan: {
        version: "3",
        fit: "stretch",
        requirements: [],
        summaryClaims: [],
        summaryBlueprint: {
          positioningMode: "transition",
          archetype: "career-shifter",
          targetIdentityAllowed: false,
          mustUseKeywords: ["TypeScript", "CI/CD", "API Design"],
          proofPoints: ["Built TypeScript APIs used by 12 internal teams.", "Reduced deployment time by 25% through CI automation."],
          mustAvoidClaims: ["established Backend Engineer identity"],
          includeYearsOfExperience: { include: false, reason: "Career shift" }
        },
        roles: [],
        skills: [],
        certifications: [],
        sectionOrder: [],
        pageTarget: "one"
      }
    });
    const result = evaluateTailoredCv(profile, job, cv);
    expect(result.checks.find((item) => item.id === "summary-archetype-fit")?.status).toBe("warn");
    expect(result.checks.find((item) => item.id === "summary-keyword-coverage")?.status).toBe("warn");
    expect(result.checks.find((item) => item.id === "summary-proof-density")?.status).toBe("warn");
  });
});
