import { describe, expect, it } from "vitest";
import { emptyStorageState, makeId, tailoringJobKey, type BaseProfile, type JobDescription, type StorageState, type TailoringJob } from "@cv-tailor/shared";
import { activeTailoringFor, selectPopupView } from "./popupView";

const profile = (): BaseProfile => ({
  id: makeId("profile"), contact: { name: "", email: "", phone: "", location: "", linkedIn: "" },
  targetRole: "", outputLanguage: "en", summary: "", experiences: [], education: [], skills: [], skillCategories: {}, certifications: [], languages: [], sectionOrder: [], dismissedChecks: [], rawText: "", updatedAt: ""
});

const job = (): JobDescription => ({ title: "Engineer", company: "Acme", location: "", description: "x".repeat(40), url: "", source: "manual" });

// Signed-in baseline: every view below "signed-out" assumes an account exists.
const signedIn = (): StorageState => ({
  ...emptyStorageState(),
  auth: { userId: "u1", email: "user@example.com", name: "", token: "tok", expiresAt: "" }
});

function onboarded(): StorageState {
  const state = signedIn();
  return { ...state, profile: profile(), settings: { ...state.settings, onboardingComplete: true } };
}

describe("selectPopupView", () => {
  it("shows the sign-in prompt when there is no account", () => {
    expect(selectPopupView(emptyStorageState(), null, null)).toBe("signed-out");
    expect(selectPopupView(emptyStorageState(), job(), null)).toBe("signed-out");
  });

  it("shows the new-user welcome when there is no base CV and no job", () => {
    expect(selectPopupView(signedIn(), null, null)).toBe("new-user");
  });

  it("shows the demo for an onboarded user with no job", () => {
    expect(selectPopupView(onboarded(), null, null)).toBe("no-job");
  });

  it("prompts to build the base CV when a job is imported but no CV exists", () => {
    expect(selectPopupView(signedIn(), job(), null)).toBe("build-cv");
  });

  it("shows the job view for an onboarded user with a job", () => {
    expect(selectPopupView(onboarded(), job(), null)).toBe("job");
  });

  it("prioritizes LinkedIn scan states over the new-user welcome when no job is selected", () => {
    const loading = { status: "loading", identity: "1", reason: "Reading…" } as const;
    const unsupported = { status: "unsupported", identity: "1", reason: "Could not read." } as const;
    expect(selectPopupView(signedIn(), null, loading)).toBe("linkedin-loading");
    expect(selectPopupView(signedIn(), null, unsupported)).toBe("linkedin-unsupported");
  });

  it("ignores LinkedIn scan state once a job is resolved", () => {
    const loading = { status: "loading", identity: "1", reason: "Reading…" } as const;
    expect(selectPopupView(onboarded(), job(), loading)).toBe("job");
  });
});

describe("activeTailoringFor", () => {
  const jobA = (): JobDescription => ({ title: "Engineer", company: "Acme", location: "", description: "x".repeat(40), url: "https://jobs/a", source: "manual" });
  const jobB = (): JobDescription => ({ title: "Designer", company: "Globex", location: "", description: "y".repeat(40), url: "https://jobs/b", source: "manual" });
  const doneFor = (j: JobDescription): TailoringJob => ({ status: "done", error: "", cvId: "cv_1", jobKey: tailoringJobKey(j), startedAt: 0 });

  it("returns null when there is no tailoring slot", () => {
    expect(activeTailoringFor(null, jobA())).toBeNull();
  });

  it("applies the slot when its jobKey matches the job on screen", () => {
    const tj = doneFor(jobA());
    expect(activeTailoringFor(tj, jobA())).toBe(tj);
  });

  it("ignores a finished job's slot when a DIFFERENT job is on screen (no hijack)", () => {
    // Regression: a done tailoring for job A must not block Generate for job B.
    expect(activeTailoringFor(doneFor(jobA()), jobB())).toBeNull();
  });

  it("keeps the just-finished slot visible when no job is selected (happy path)", () => {
    const tj = doneFor(jobA());
    expect(activeTailoringFor(tj, null)).toBe(tj);
  });
});
