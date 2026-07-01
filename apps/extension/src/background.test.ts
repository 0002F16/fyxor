import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  upsertTailoringJob: vi.fn(),
  removeTailoringJob: vi.fn(),
  updateState: vi.fn(),
  tailor: vi.fn(),
  messageListener: null as ((message: any, sender: any, sendResponse: (response: any) => void) => void) | null
}));

vi.mock("./api", () => ({ api: { tailor: mocks.tailor } }));
vi.mock("./selection", () => ({ jobFromSelection: vi.fn() }));
vi.mock("./storage", () => ({
  getState: mocks.getState,
  queuePendingJob: vi.fn(),
  upsertTailoringJob: mocks.upsertTailoringJob,
  removeTailoringJob: mocks.removeTailoringJob,
  updateState: mocks.updateState
}));

describe("background tailoring start", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.messageListener = null;
    mocks.getState.mockResolvedValue({
      // A different job's finished run is already tracked in storage; starting
      // a new job must not be blocked by it now that several can run at once.
      tailoringJobs: {
        "https://jobs.example/other": {
          status: "done",
          error: "",
          cvId: "cv-other",
          runId: "run-other",
          jobKey: "https://jobs.example/other",
          startedAt: 0
        }
      },
      settings: { apiBaseUrl: "http://127.0.0.1:8787", aiProvider: "deepseek-api" }
    });
    mocks.upsertTailoringJob.mockResolvedValue(undefined);
    mocks.removeTailoringJob.mockResolvedValue(undefined);
    mocks.updateState.mockResolvedValue(undefined);
    mocks.tailor.mockResolvedValue({ id: "cv-1" });

    vi.stubGlobal("chrome", {
      action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        openPopup: vi.fn().mockResolvedValue(undefined)
      },
      contextMenus: {
        remove: vi.fn((_id, callback) => callback()),
        create: vi.fn((_options, callback) => callback()),
        onClicked: { addListener: vi.fn() }
      },
      runtime: {
        getPlatformInfo: vi.fn().mockResolvedValue({}),
        getURL: vi.fn((path) => path),
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: {
          addListener: vi.fn((listener) => {
            mocks.messageListener = listener;
          })
        }
      },
      tabs: {
        create: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(null)
      }
    });
  });

  it("starts the API request even when storage contains a different job's running slot", async () => {
    await import("./background");

    const sendResponse = vi.fn();
    mocks.messageListener?.({
      type: "CV_TAILOR_START_TAILORING",
      payload: {
        apiBaseUrl: "http://127.0.0.1:8787",
        aiProvider: "gemini-api",
        profile: { id: "profile-1" },
        job: { title: "Engineer", company: "Acme", url: "https://jobs.example/1" },
        tailoringEngine: "ccc"
      }
    }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await vi.waitFor(() => expect(mocks.tailor).toHaveBeenCalledTimes(1));
    expect(mocks.tailor).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "deepseek-api",
      { id: "profile-1" },
      { title: "Engineer", company: "Acme", url: "https://jobs.example/1" },
      "ccc",
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it("refuses to start the same job twice while it's already tracked", async () => {
    await import("./background");

    const payload = {
      apiBaseUrl: "http://127.0.0.1:8787",
      aiProvider: "gemini-api",
      profile: { id: "profile-1" },
      job: { title: "Engineer", company: "Acme", url: "https://jobs.example/dup" },
      tailoringEngine: "ccc"
    };
    const first = vi.fn();
    const second = vi.fn();
    mocks.messageListener?.({ type: "CV_TAILOR_START_TAILORING", payload }, {}, first);
    mocks.messageListener?.({ type: "CV_TAILOR_START_TAILORING", payload }, {}, second);

    expect(first).toHaveBeenCalledWith({ ok: true });
    expect(second).toHaveBeenCalledWith({ ok: false });
  });
});
