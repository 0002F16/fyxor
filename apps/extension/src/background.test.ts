import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setTailoringJob: vi.fn(),
  updateState: vi.fn(),
  tailor: vi.fn(),
  messageListener: null as ((message: any, sender: any, sendResponse: (response: any) => void) => void) | null
}));

vi.mock("./api", () => ({ api: { tailor: mocks.tailor } }));
vi.mock("./selection", () => ({ jobFromSelection: vi.fn() }));
vi.mock("./storage", () => ({
  getState: mocks.getState,
  queuePendingJob: vi.fn(),
  setTailoringJob: mocks.setTailoringJob,
  updateState: mocks.updateState
}));

describe("background tailoring start", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.messageListener = null;
    mocks.getState.mockResolvedValue({
      tailoringJob: {
        status: "running",
        error: "",
        cvId: "",
        jobKey: "https://jobs.example/1",
        startedAt: Date.now()
      }
    });
    mocks.setTailoringJob.mockResolvedValue(undefined);
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

  it("starts the API request even when storage contains the popup's running UI slot", async () => {
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
      "gemini-api",
      { id: "profile-1" },
      { title: "Engineer", company: "Acme", url: "https://jobs.example/1" },
      "ccc",
      expect.any(AbortSignal)
    );
  });
});
