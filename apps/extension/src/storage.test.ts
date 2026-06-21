import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDescription } from "@cv-tailor/shared";
import { clearPendingJob, getState, queuePendingJob } from "./storage";

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
