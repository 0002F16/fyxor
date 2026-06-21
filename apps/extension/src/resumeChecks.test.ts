import { describe, expect, it } from "vitest";
import { evaluateResume } from "./resumeChecks";

type Doc = Parameters<typeof evaluateResume>[0];

function baseDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    contact: { name: "Jane Doe", email: "jane@example.com", phone: "+1 555", location: "London", linkedIn: "linkedin.com/in/jane" },
    summary: "Experienced engineer with a decade building reliable backend systems.",
    experiences: [
      { id: "e1", company: "Acme", role: "Engineer", startDate: "2020", endDate: "Present", bullets: ["Shipped X", "Led Y"] }
    ],
    education: [{ id: "ed1", school: "University of Leeds", degree: "BSc Computer Science", location: "Leeds, UK", graduationDate: "2019", gpa: "", honors: "", coursework: [] }],
    skills: ["TypeScript", "Go", "Python", "AWS", "Docker"],
    skillCategories: { Languages: ["TypeScript", "Go", "Python"], Tools: ["AWS", "Docker"] },
    certifications: [],
    languages: [],
    targetRole: "Backend Engineer",
    ...overrides
  } as Doc;
}

const ids = (doc: Doc, kind: "base" | "tailored" = "base", dismissed: string[] = []) =>
  evaluateResume(doc, kind, dismissed).checks.map((c) => c.id);

describe("evaluateResume", () => {
  it("scores a complete profile at 100 with no outstanding checks", () => {
    const result = evaluateResume(baseDoc(), "base");
    expect(result.score).toBe(100);
    expect(result.checks).toEqual([]);
  });

  it("flags a single skills bucket", () => {
    const doc = baseDoc({ skillCategories: { Skills: ["TypeScript", "Go", "Python", "AWS", "Docker"] } });
    expect(ids(doc)).toContain("skills-groups");
  });

  it("passes skills-groups when there are multiple non-empty buckets", () => {
    expect(ids(baseDoc())).not.toContain("skills-groups");
  });

  it("flags a thin skill count", () => {
    const doc = baseDoc({ skills: ["TypeScript"], skillCategories: { A: ["TypeScript"], B: [] } });
    expect(ids(doc)).toContain("skills-count");
  });

  it("flags a too-short summary", () => {
    expect(ids(baseDoc({ summary: "Engineer." }))).toContain("summary");
  });

  it("flags roles with fewer than two bullets", () => {
    const doc = baseDoc({ experiences: [{ id: "e1", company: "Acme", role: "Engineer", startDate: "", endDate: "", bullets: ["Only one"] }] });
    expect(ids(doc)).toContain("experience-bullets");
  });

  it("includes tailored-only checks only for tailored CVs", () => {
    const tailored = baseDoc({ job: { title: "Backend Engineer" }, unsupportedClaims: [{}] } as Partial<Doc>);
    expect(ids(tailored, "tailored")).toContain("unsupported-claims");
    expect(ids(baseDoc())).not.toContain("unsupported-claims");
  });

  it("uses job.title for the headline check on tailored CVs", () => {
    const missing = baseDoc({ job: { title: "" }, targetRole: "" } as Partial<Doc>);
    expect(ids(missing, "tailored")).toContain("headline");
    const present = baseDoc({ job: { title: "Backend Engineer" } } as Partial<Doc>);
    expect(ids(present, "tailored")).not.toContain("headline");
  });

  it("excludes dismissed checks from the list and raises the score", () => {
    const doc = baseDoc({ skillCategories: { Skills: ["TypeScript", "Go", "Python", "AWS", "Docker"] } });
    const before = evaluateResume(doc, "base");
    const after = evaluateResume(doc, "base", ["skills-groups"]);
    expect(before.checks.map((c) => c.id)).toContain("skills-groups");
    expect(after.checks.map((c) => c.id)).not.toContain("skills-groups");
    expect(after.score).toBeGreaterThanOrEqual(before.score);
  });

  it("flags missing required contact fields", () => {
    const doc = baseDoc({ contact: { name: "", email: "", phone: "", location: "", linkedIn: "" } });
    const flagged = ids(doc);
    expect(flagged).toContain("contact-name");
    expect(flagged).toContain("contact-email");
  });
});
