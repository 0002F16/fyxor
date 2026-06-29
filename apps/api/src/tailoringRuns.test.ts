import { describe, expect, it, vi } from "vitest";
import type { BaseProfile, JobDescription } from "@cv-tailor/shared";
import type { Generator } from "./openai";
import { cancelTailoringRun, createTailoringRun, getTailoringRun } from "./tailoringRuns";

const profile: BaseProfile = {
  id: "run-profile",
  contact: { name: "Jane", email: "jane@example.com", phone: "", location: "", linkedIn: "" },
  targetRole: "Developer",
  summary: "",
  experiences: [{ id: "source-1", company: "Acme", role: "Developer", startDate: "2023", endDate: "Present", bullets: ["Built APIs."] }],
  education: [],
  skills: ["API Design"],
  skillCategories: { Engineering: ["API Design"] },
  certifications: [],
  languages: [],
  sectionOrder: [],
  style: { preset: "modern" },
  dismissedChecks: [],
  rawText: "Developer at Acme. Built APIs.",
  updatedAt: "2026-06-23T00:00:00.000Z"
};
const job: JobDescription = {
  title: "Backend Developer",
  company: "Target",
  location: "",
  description: "Design and build reliable APIs for backend services.",
  url: "https://example.com/run",
  source: "manual"
};
const plan = {
  version: "1", fit: "direct", requirements: [{ id: "r1", text: "APIs", priority: "must" }],
  summaryClaims: [{ id: "c1", objective: "API experience", evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }] }],
  roles: [{
    sourceExperienceId: "source-1", include: true, originalTitle: "Developer", proposedTitle: "Backend Developer",
    titleEvidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }], titleConfidence: "high",
    bulletObjectives: [{ id: "b1", objective: "API work", sourceBulletIndexes: [0] }]
  }],
  skills: [{ skill: "API Design", category: "Engineering", requirementIds: ["r1"], evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }] }],
  certifications: [], sectionOrder: [], pageTarget: "one"
};
const writer = {
  summary: "Developer bringing practical API design experience to backend teams.",
  summaryClaims: [{ id: "c1", text: "Practical API design experience", evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }] }],
  roles: [{ sourceExperienceId: "source-1", displayTitle: "Backend Developer", bullets: [{ id: "tb1", text: "Built APIs for internal services.", sourceBulletIndexes: [0] }] }],
  skillCategories: [{ name: "Engineering", skills: ["API Design"] }],
  skillEvidence: [{ skill: "API Design", evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }] }],
  certifications: []
};
const critic = { scores: { relevance: 5, credibility: 5, readability: 5, appropriateness: 5 }, findings: [] };

describe("tailoring runs", () => {
  it("deduplicates active requests and completes asynchronously", async () => {
    const responses = [plan, writer, critic];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const factory = () => ({ generate });
    const first = await createTailoringRun({ userId: "run-user", provider: "gemini-api", profile, job, testMode: true, generatorFactory: factory });
    const duplicate = await createTailoringRun({ userId: "run-user", provider: "gemini-api", profile, job, testMode: true, generatorFactory: factory });
    expect(duplicate.id).toBe(first.id);

    let current = await getTailoringRun(first.id, "run-user", true);
    for (let i = 0; i < 50 && current?.status !== "completed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await getTailoringRun(first.id, "run-user", true);
    }
    expect(current?.status).toBe("completed");
    expect(current?.cv?.pipeline.runId).toBe(first.id);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("persists cancellation and stops before the next stage", async () => {
    let releasePlan!: () => void;
    const waitForPlan = new Promise<void>((resolve) => { releasePlan = resolve; });
    const generate = vi.fn(async () => {
      await waitForPlan;
      return plan;
    }) as unknown as Generator["generate"];
    const run = await createTailoringRun({
      userId: "cancel-user",
      provider: "gemini-api",
      profile: { ...profile, id: "cancel-profile" },
      job: { ...job, url: "https://example.com/cancel" },
      testMode: true,
      generatorFactory: () => ({ generate })
    });
    await cancelTailoringRun(run.id, "cancel-user", true);
    releasePlan();

    let current = await getTailoringRun(run.id, "cancel-user", true);
    for (let i = 0; i < 50 && current?.status !== "cancelled"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await getTailoringRun(run.id, "cancel-user", true);
    }
    expect(current?.status).toBe("cancelled");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
