import { describe, expect, it } from "vitest";
import { applyRegeneratedSection, baseProfileSchema, bulletHasMetric, educationHasContent, emptyStorageState, flattenSkillCategories, formatEducationEntry, migrateStorage, normalizeSkillCategories, resumeStyleVars, tailoredCvSchema, tailoringJobKey } from "./index";

describe("applyRegeneratedSection", () => {
  // Builds a valid TailoredCv the user has been editing, with distinct content
  // in every section so we can assert nothing leaks across a section regenerate.
  const current = () => tailoredCvSchema.parse({
    id: "cv1", baseProfileId: "p1",
    job: { title: "Engineer", company: "Acme", description: "x".repeat(40) },
    outputLanguage: "en", contact: { name: "Jane" },
    summary: "EDITED summary the user just typed",
    experiences: [
      { id: "e1", company: "Acme", role: "Dev", bullets: ["edited e1 bullet"] },
      { id: "e2", company: "Globex", role: "Lead", bullets: ["edited e2 bullet"] }
    ],
    education: [], skills: ["EditedSkill"], skillCategories: { Edited: ["EditedSkill"] },
    sectionOrder: ["skills", "summary", "experience"], dismissedChecks: ["check-1"],
    createdAt: "t0", updatedAt: "t0"
  });

  it("replaces only the summary, preserving edited experiences/skills/order/state", () => {
    const regenerated = tailoredCvSchema.parse({ ...current(), summary: "AI summary", experiences: [], skills: ["wiped"], skillCategories: {}, sectionOrder: [], dismissedChecks: [] });
    const out = applyRegeneratedSection(current(), regenerated, "summary");
    expect(out.summary).toBe("AI summary");
    expect(out.experiences.map((e) => e.bullets)).toEqual([["edited e1 bullet"], ["edited e2 bullet"]]);
    expect(out.skills).toEqual(["EditedSkill"]);
    expect(out.sectionOrder).toEqual(["skills", "summary", "experience"]);
    expect(out.dismissedChecks).toEqual(["check-1"]);
  });

  it("replaces only skills (flat + categories), preserving the edited summary", () => {
    const regenerated = tailoredCvSchema.parse({ ...current(), summary: "wiped", skills: ["Go", "Rust"], skillCategories: { Languages: ["Go", "Rust"] } });
    const out = applyRegeneratedSection(current(), regenerated, "skills");
    expect(out.skills).toEqual(["Go", "Rust"]);
    expect(out.skillCategories).toEqual({ Languages: ["Go", "Rust"] });
    expect(out.summary).toBe("EDITED summary the user just typed");
  });

  it("replaces only the targeted experience by id, leaving the other edited", () => {
    const regenerated = tailoredCvSchema.parse({
      ...current(), summary: "wiped",
      experiences: [
        { id: "e1", company: "Acme", role: "Dev", bullets: ["AI e1 bullet"] },
        { id: "e2", company: "Globex", role: "Lead", bullets: ["AI e2 bullet (should be ignored)"] }
      ]
    });
    const out = applyRegeneratedSection(current(), regenerated, "experience", "e1");
    expect(out.experiences[0]!.bullets).toEqual(["AI e1 bullet"]);
    expect(out.experiences[1]!.bullets).toEqual(["edited e2 bullet"]); // untouched
    expect(out.summary).toBe("EDITED summary the user just typed");
  });

  it("is a no-op when the experienceId matches nothing", () => {
    const regenerated = tailoredCvSchema.parse({ ...current(), experiences: [{ id: "zzz", company: "X", role: "Y", bullets: ["nope"] }] });
    expect(applyRegeneratedSection(current(), regenerated, "experience", "missing")).toEqual(current());
  });
});

describe("tailoringJobKey", () => {
  it("returns empty string for no job", () => {
    expect(tailoringJobKey(null)).toBe("");
    expect(tailoringJobKey(undefined)).toBe("");
  });

  it("prefers the URL when present (unique per posting)", () => {
    expect(tailoringJobKey({ url: "https://jobs/123", title: "Eng", company: "Acme" })).toBe("https://jobs/123");
  });

  it("falls back to title+company when there is no URL", () => {
    expect(tailoringJobKey({ title: "Eng", company: "Acme" })).toBe("Eng@@Acme");
  });

  it("distinguishes different jobs and matches identical ones", () => {
    expect(tailoringJobKey({ title: "Eng", company: "Acme" })).not.toBe(tailoringJobKey({ title: "Eng", company: "Globex" }));
    expect(tailoringJobKey({ url: " https://jobs/1 " })).toBe(tailoringJobKey({ url: "https://jobs/1" }));
  });
});

describe("storage migration", () => {
  it("creates a clean state from invalid data", () => {
    expect(migrateStorage({ version: 99 })).toEqual(emptyStorageState());
  });

  it("keeps valid version one state", () => {
    const state = emptyStorageState();
    expect(migrateStorage(state)).toEqual(state);
  });

  it("adds pendingJob without resetting existing version one data", () => {
    const { pendingJob: _pendingJob, ...state } = emptyStorageState();
    const { aiProvider: _aiProvider, ...oldSettings } = state.settings;
    const previous = { ...state, settings: oldSettings };
    expect(migrateStorage(previous).pendingJob).toBeNull();
    expect(migrateStorage(previous).settings.aiProvider).toBe("gemini-api");
    expect(migrateStorage(previous).settings.apiBaseUrl).toBe(previous.settings.apiBaseUrl);
  });
});

describe("skill category helpers", () => {
  it("prefers themed categories when present", () => {
    expect(normalizeSkillCategories({ Languages: ["Go"] }, ["ignored"])).toEqual([["Languages", ["Go"]]]);
  });

  it("wraps flat skills in a single group as a fallback", () => {
    expect(normalizeSkillCategories({}, ["Go", "Rust"])).toEqual([["Skills", ["Go", "Rust"]]]);
  });

  it("yields nothing for empty data unless includeEmpty is set", () => {
    expect(normalizeSkillCategories({}, [])).toEqual([]);
    expect(normalizeSkillCategories({}, [], true)).toEqual([["Skills", []]]);
  });

  it("flattens to a de-duplicated union", () => {
    expect(flattenSkillCategories([["A", ["x", "y"]], ["B", ["y", "z"]]])).toEqual(["x", "y", "z"]);
  });
});

describe("bulletHasMetric", () => {
  it("detects bullets with a quantified outcome", () => {
    expect(bulletHasMetric("Cut deploy time 40%")).toBe(true);
    expect(bulletHasMetric("Led a team of 6 engineers")).toBe(true);
    expect(bulletHasMetric("Grew revenue to $1.2M")).toBe(true);
    expect(bulletHasMetric("Improved throughput 3x")).toBe(true);
  });

  it("flags bullets with no number", () => {
    expect(bulletHasMetric("Responsible for the deployment pipeline")).toBe(false);
    expect(bulletHasMetric("")).toBe(false);
  });
});

describe("education entries", () => {
  const parseEducation = (education: unknown) =>
    baseProfileSchema.parse({ id: "p1", contact: {}, education, updatedAt: "now" }).education;

  it("migrates legacy string education into structured entries", () => {
    const result = parseEducation(["BSc Computer Science, University of Leeds, 2019"]);
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.school).toBe("BSc Computer Science, University of Leeds, 2019");
    expect(entry.id).toBeTruthy();
    expect(entry.coursework).toEqual([]);
  });

  it("assigns an id to a structured entry that lacks one", () => {
    const entry = parseEducation([{ school: "MIT", degree: "BSc Physics" }])[0]!;
    expect(entry.id).toBeTruthy();
    expect(entry.degree).toBe("BSc Physics");
  });

  it("treats an entry with no content as empty", () => {
    expect(educationHasContent({ id: "e", school: "", degree: "", location: "", graduationDate: "", gpa: "", honors: "", coursework: [] })).toBe(false);
    expect(educationHasContent({ id: "e", school: "MIT", degree: "", location: "", graduationDate: "", gpa: "", honors: "", coursework: [] })).toBe(true);
  });

  it("formats an entry into Harvard-style lines", () => {
    const fmt = formatEducationEntry({ id: "e", school: "Harvard University", degree: "A.B. in Economics", location: "Cambridge, MA", graduationDate: "May 2024", gpa: "3.8", honors: "Magna Cum Laude", coursework: ["Econometrics", ""] });
    expect(fmt.title).toBe("Harvard University, Cambridge, MA");
    expect(fmt.subtitle).toBe("A.B. in Economics, Magna Cum Laude · GPA 3.8");
    expect(fmt.meta).toBe("May 2024");
    expect(fmt.bullets).toEqual(["Econometrics"]);
  });
});

describe("resumeStyleVars", () => {
  it("defaults to the modern emerald sans preset when style is undefined", () => {
    const v = resumeStyleVars(undefined);
    expect(v["--cv-accent-rgb"]).toBe("5 150 105"); // #059669
    expect(v["--cv-font-body"]).toBe("Inter, sans-serif");
    expect(v["--cv-font-display"]).toBe("'Plus Jakarta Sans', Inter, sans-serif");
  });

  it("maps the serif presets to serif fonts", () => {
    expect(resumeStyleVars({ preset: "garamond" })["--cv-font-body"]).toBe("'EB Garamond', Garamond, serif");
    expect(resumeStyleVars({ preset: "times" })["--cv-font-body"]).toBe("'Times New Roman', Tinos, serif");
  });

  it("makes serif presets monochrome (every accent collapses to ink)", () => {
    for (const preset of ["garamond", "times"] as const) {
      const v = resumeStyleVars({ preset });
      expect(v["--cv-accent-rgb"]).toBe("15 23 42"); // #0f172a ink
      expect(v["--cv-accent-deep-rgb"]).toBe("15 23 42");
      expect(v["--cv-highlight-rgb"]).toBe("241 245 249"); // #f1f5f9
    }
  });
});
