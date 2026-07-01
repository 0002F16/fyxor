import { describe, expect, it, vi } from "vitest";
import type { BaseProfile, JobDescription } from "@cv-tailor/shared";
import type { Generator } from "./openai";
import { cancelTailoringRun, createTailoringRun, getTailoringRun, schedulerStatus } from "./tailoringRuns";

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
    // The writer runs as three section calls (resume_summary / resume_experience /
    // resume_skills); dispatch by call name rather than a fixed sequence.
    const byName: Record<string, unknown> = {
      evidence_plan: plan,
      resume_summary: { summary: writer.summary, summaryClaims: writer.summaryClaims },
      resume_experience: { roles: writer.roles },
      resume_skills: { skillCategories: writer.skillCategories },
      resume_critic: critic,
      resume_critic_recheck: critic,
      resume_repair: writer
    };
    const generate = vi.fn(async ({ name }: { name: string }) => byName[name]) as unknown as Generator["generate"];
    const factory = () => ({ generate });
    const first = await createTailoringRun({ userId: "run-user", provider: "deepseek-api", profile, job, testMode: true, generatorFactory: factory });
    const duplicate = await createTailoringRun({ userId: "run-user", provider: "deepseek-api", profile, job, testMode: true, generatorFactory: factory });
    expect(duplicate.id).toBe(first.id);

    let current = await getTailoringRun(first.id, "run-user", true);
    for (let i = 0; i < 50 && current?.status !== "completed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await getTailoringRun(first.id, "run-user", true);
    }
    expect(current?.status).toBe("completed");
    expect(current?.cv?.pipeline.runId).toBe(first.id);
    expect(generate).toHaveBeenCalledTimes(5);
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
      provider: "deepseek-api",
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

  it("caps a single user at the per-user concurrent limit and drains the queue as runs finish", async () => {
    // Four distinct jobs for the same user, each blocked on its own gate so we
    // control exactly when a "running" slot frees up.
    const gates = [0, 1, 2, 3].map(() => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      return { wait, release };
    });
    const [gateA, gateB, gateC, gateD] = gates;
    const runs = await Promise.all(
      gates.map((gate, i) => {
        const generate = vi.fn(async () => {
          await gate.wait;
          return plan;
        }) as unknown as Generator["generate"];
        return createTailoringRun({
          userId: "cap-user",
          provider: "deepseek-api",
          profile: { ...profile, id: `cap-profile-${i}` },
          job: { ...job, url: `https://example.com/cap-${i}` },
          testMode: true,
          generatorFactory: () => ({ generate })
        });
      })
    );
    const [runA, runB, runC, runD] = runs;

    const statusOf = async (id: string) => (await getTailoringRun(id, "cap-user", true))?.status;
    expect(await statusOf(runA!.id)).toBe("running");
    expect(await statusOf(runB!.id)).toBe("running");
    expect(await statusOf(runC!.id)).toBe("running");
    // The 4th exceeds the default per-user cap (3) and stays queued instead of
    // starting its LLM calls.
    expect(await statusOf(runD!.id)).toBe("queued");
    expect(schedulerStatus().running).toBeGreaterThanOrEqual(3);

    // Freeing one running slot should let the queued run start.
    gateA!.release();
    let fourthStatus = await statusOf(runD!.id);
    for (let i = 0; i < 50 && fourthStatus !== "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fourthStatus = await statusOf(runD!.id);
    }
    expect(fourthStatus).toBe("running");

    // Let the rest settle (the mock returns a plan-shaped payload for every
    // call name, so later pipeline stages may reject it — this test only
    // cares that the scheduler drains the queue, not full pipeline success).
    gateB!.release();
    gateC!.release();
    gateD!.release();
    for (const run of runs) {
      let current = await statusOf(run.id);
      for (let i = 0; i < 50 && (current === "running" || current === "queued"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = await statusOf(run.id);
      }
      expect(["completed", "failed"]).toContain(current);
    }
  });
});
