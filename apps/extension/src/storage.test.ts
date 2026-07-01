import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDescription, TailoringJob } from "@cv-tailor/shared";
import { clearPendingJob, getState, queuePendingJob, removeTailoringJob, upsertTailoringJob } from "./storage";

const job: JobDescription = {
  title: "Product Manager",
  company: "Example",
  location: "",
  description: "A sufficiently long selected job description for the popup.",
  url: "https://jobs.example.com/1",
  source: "manual"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pending popup job", () => {
  it("persists until it is explicitly cleared", async () => {
    const storage: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storage, value))
        }
      }
    });

    await queuePendingJob(job);
    expect((await getState()).pendingJob).toEqual(job);

    await clearPendingJob();
    expect((await getState()).pendingJob).toBeNull();
  });
});

describe("multi-run tailoring jobs", () => {
  it("tracks several jobs independently, keyed by jobKey", async () => {
    const storage: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(storage, value))
        }
      }
    });

    const runA: TailoringJob = { status: "running", error: "", cvId: "", runId: "run-a", stage: "planning", progress: 10, jobKey: "a", startedAt: 1 };
    const runB: TailoringJob = { status: "queued", error: "", cvId: "", runId: "", stage: "queued", progress: 0, jobKey: "b", startedAt: 2 };

    await upsertTailoringJob("a", runA);
    await upsertTailoringJob("b", runB);
    let state = await getState();
    expect(state.tailoringJobs).toEqual({ a: runA, b: runB });

    await removeTailoringJob("a");
    state = await getState();
    expect(state.tailoringJobs).toEqual({ b: runB });
  });
});
