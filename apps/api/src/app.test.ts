import { afterEach, describe, expect, it } from "vitest";
import { clientRun, createApp } from "./app";
import type { Generator } from "./openai";

process.env.ENABLE_LEGACY_ENGINES = "true";

const profile = {
  id: "p1",
  contact: { name: "Karol", email: "", phone: "", location: "", linkedIn: "" },
  targetRole: "Product Manager",
  summary: "Product manager",
  experiences: [],
  education: [],
  skills: ["Product strategy"],
  rawText: "Product manager with product strategy experience.",
  updatedAt: new Date().toISOString()
};

const job = {
  title: "Product Manager",
  company: "Acme",
  location: "Warsaw",
  description: "A sufficiently long job description requiring product strategy and stakeholder management.",
  url: "",
  source: "manual" as const
};

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("API routes", () => {
  it("serves health and validates a mocked tailored CV response", async () => {
    const now = new Date().toISOString();
    const generator: Generator = {
      generate: async () => ({
        id: "cv1",
        baseProfileId: "p1",
        job,
        contact: profile.contact,
        summary: "Product manager focused on product strategy.",
        experiences: [],
        education: [],
        skills: ["Product strategy", "Roadmapping"],
        skillCategories: [{ name: "Strategy", skills: ["Product strategy", "Roadmapping"] }],
        unsupportedClaims: [],
        createdAt: now,
        updatedAt: now
      }) as never
    };
    const server = createApp(() => generator).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/health`).then((response) => response.json());
    expect(health.configured).toBe(true);

    const response = await fetch(`${base}/api/cvs/tailor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, job, tailoringEngine: "builtin" })
    });
    expect(response.status).toBe(200);
    const tailored = await response.json();
    expect(tailored.id).toBe("cv1");
    // The built-in tailor folds the LLM's array-form categories into the record
    // shape and re-derives the flat union (regression: categories used to drop).
    expect(tailored.skillCategories).toEqual({ Strategy: ["Product strategy", "Roadmapping"] });
    expect(tailored.skills).toEqual(["Product strategy", "Roadmapping"]);
  });

  it("folds extracted skill categories into a record and a flat union", async () => {
    const now = new Date().toISOString();
    const generator: Generator = {
      generate: async () => ({
        id: "p1",
        contact: profile.contact,
        targetRole: "Product Manager",
        summary: "Product manager",
        experiences: [],
        education: [],
        skills: [],
        skillCategories: [
          { name: "Strategy", skills: ["Roadmapping", "Discovery"] },
          { name: "Tools", skills: ["Jira", "Roadmapping", "Advanced Excel", "Power Query", "Pivot Tables", "VLOOKUP"] },
          { name: "", skills: ["ignored"] }
        ],
        certifications: ["ACCA F3 Financial Accounting (In Progress — Expected Jun 2026)"],
        languages: [{ language: "English", level: "B2" }],
        rawText: "",
        updatedAt: now
      }) as never
    };
    const server = createApp(() => generator).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/api/profile/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "A CV with more than thirty characters of content." })
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.skillCategories).toEqual({
      Strategy: ["Roadmapping", "Discovery"],
      Tools: ["Jira", "Roadmapping", "Advanced Excel", "Power Query", "Pivot Tables", "VLOOKUP"]
    });
    // Flat union is de-duplicated and drops the empty-named category.
    expect(result.skills).toEqual(["Roadmapping", "Discovery", "Jira", "Advanced Excel", "Power Query", "Pivot Tables", "VLOOKUP"]);
    expect(result.certifications).toEqual(["ACCA F3 Financial Accounting (In Progress — Expected Jun 2026)"]);
    expect(result.languages).toEqual([{ language: "English", level: "B2" }]);
  });

  it("applies title review after tailoring when source evidence is available", async () => {
    const now = new Date().toISOString();
    const experiencedProfile = {
      ...profile,
      experiences: [{
        id: "source-1",
        company: "Acme",
        role: "Software Developer",
        startDate: "2022",
        endDate: "2024",
        bullets: ["Built Node.js APIs and database integrations."]
      }],
      skills: ["Node.js", "API design"]
    };
    const calls: string[] = [];
    const generator: Generator = {
      generate: async (input) => {
        calls.push(input.name);
        if (input.name === "experience_title_review") {
          return { titles: [{ sourceExperienceId: "source-1", title: "Backend Developer" }] } as never;
        }
        return {
          id: "cv-reviewed",
          baseProfileId: "p1",
          job,
          contact: profile.contact,
          summary: "Backend-focused software developer.",
          experiences: [{
            id: "tailored-1",
            company: "Acme",
            role: "Software Developer",
            originalRole: "Software Developer",
            titleEvidenceStatus: "unchanged",
            startDate: "2022",
            endDate: "2024",
            bullets: [{ id: "b1", text: "Built Node.js APIs and database integrations.", sourceBulletIndexes: [0], evidenceStatus: "verified" }],
            sourceExperienceId: "source-1",
            sourceBulletIndexes: [0]
          }],
          education: [],
          skills: ["Node.js", "API design"],
          skillCategories: [{ name: "Backend", skills: ["Node.js", "API design"] }],
          unsupportedClaims: [],
          createdAt: now,
          updatedAt: now
        } as never;
      }
    };
    const server = createApp(() => generator).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/cvs/tailor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: experiencedProfile, job, tailoringEngine: "builtin" })
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(calls).toEqual(["tailored_cv", "experience_title_review"]);
    expect(result.experiences[0].role).toBe("Backend Developer");
  });

  it("reviews titles only for experience regeneration", async () => {
    const now = new Date().toISOString();
    const experiencedProfile = {
      ...profile,
      experiences: [{
        id: "source-1",
        company: "Acme",
        role: "Software Developer",
        startDate: "2022",
        endDate: "2024",
        bullets: ["Built Node.js APIs and database integrations."]
      }]
    };
    const cv = {
      id: "cv-1",
      baseProfileId: "p1",
      job,
      contact: profile.contact,
      summary: "Software developer.",
      experiences: [{
        id: "tailored-1",
        company: "Acme",
        role: "Software Developer",
        originalRole: "Software Developer",
        titleEvidenceStatus: "unchanged" as const,
        startDate: "2022",
        endDate: "2024",
        bullets: [{ id: "b1", text: "Built Node.js APIs.", sourceBulletIndexes: [0], evidenceStatus: "verified" as const }],
        sourceExperienceId: "source-1",
        sourceBulletIndexes: [0]
      }],
      education: [],
      skills: ["Node.js"],
      skillCategories: { Backend: ["Node.js"] },
      certifications: [],
      languages: [],
      sectionOrder: [],
      style: { preset: "modern" as const },
      dismissedChecks: [],
      unsupportedClaims: [],
      createdAt: now,
      updatedAt: now
    };

    for (const section of ["experience", "summary"] as const) {
      const calls: string[] = [];
      const generator: Generator = {
        generate: async (input) => {
          calls.push(input.name);
          if (input.name === "experience_title_review") {
            return { titles: [{ sourceExperienceId: "source-1", title: "Backend Developer" }] } as never;
          }
          return {
            ...cv,
            skillCategories: [{ name: "Backend", skills: ["Node.js"] }]
          } as never;
        }
      };
      const server = createApp(() => generator).listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");

      const response = await fetch(`http://127.0.0.1:${address.port}/api/cvs/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: experiencedProfile,
          cv,
          section,
          experienceId: section === "experience" ? "tailored-1" : undefined
        })
      });
      const result = await response.json();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      expect(response.status).toBe(200);
      expect(calls).toEqual(section === "experience"
        ? ["regenerated_cv", "experience_title_review"]
        : ["regenerated_cv"]);
      expect(result.experiences[0].role).toBe(section === "experience"
        ? "Backend Developer"
        : "Software Developer");
    }
  });

  it("blocks export when edited evidence is stale", async () => {
    const now = new Date().toISOString();
    const experiencedProfile = {
      ...profile,
      contact: { ...profile.contact, email: "karol@example.com" },
      experiences: [{
        id: "source-1", company: "Acme", role: "Developer", startDate: "2022", endDate: "2024",
        bullets: ["Built APIs."]
      }],
      skills: []
    };
    const cv = {
      id: "blocked-cv", baseProfileId: "p1", job,
      contact: experiencedProfile.contact, summary: "Developer with API experience.",
      summaryClaims: [{ id: "c1", text: "API experience", evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }], evidenceStatus: "verified" as const }],
      experiences: [{
        id: "e1", sourceExperienceId: "source-1", company: "Acme", role: "Developer", originalRole: "Developer",
        titleEvidenceStatus: "unchanged" as const, startDate: "2022", endDate: "2024",
        bullets: [{ id: "b1", text: "Edited API claim.", sourceBulletIndexes: [0], evidenceStatus: "stale" as const }],
        sourceBulletIndexes: [0]
      }],
      education: [], skills: [], skillEvidence: [], skillCategories: {}, certifications: [], languages: [],
      sectionOrder: [], style: { preset: "modern" as const }, dismissedChecks: [], unsupportedClaims: [],
      pipeline: { pipelineVersion: "unified-v1", runId: "run", provider: "test", model: "test", stages: [], aiCallCount: 3, repairCount: 0 },
      readiness: "blocked" as const, createdAt: now, updatedAt: now
    };
    const generator: Generator = { generate: async () => ({}) as never };
    const server = createApp(() => generator).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/cvs/export?format=pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: experiencedProfile, cv })
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.findings.map((finding: { id: string }) => finding.id)).toContain("bullet-citations");
  });
});

describe("clientRun error sanitization", () => {
  it("replaces a raw Zod issues-array error with a friendly retry message", () => {
    const raw = '[{"code":"invalid_type","expected":"array","received":"object","path":["roles",0,"titleEvidence"],"message":"Expected array, received object"}]';
    const result = clientRun({ status: "failed", error: raw });
    expect(result.error).not.toContain("invalid_type");
    expect(result.error).toMatch(/tailor again/i);
  });

  it("keeps the cancelled message untouched", () => {
    const result = clientRun({ status: "cancelled", error: "Tailoring cancelled" });
    expect(result.error).toBe("Tailoring cancelled");
  });

  it("passes an already-friendly message through unchanged", () => {
    const friendly = "Free monthly tailoring limit reached.";
    const result = clientRun({ status: "failed", error: friendly });
    expect(result.error).toBe(friendly);
  });

  it("leaves a run without an error untouched", () => {
    const result = clientRun({ status: "completed", error: undefined });
    expect(result.error).toBeUndefined();
  });
});
