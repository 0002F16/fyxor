import { makeId, tailoringJobKey, type ApplicationRecord, type AiProvider, type BaseProfile, type JobDescription, type TailoringEngine } from "@cv-tailor/shared";
import { api } from "./api";
import { jobFromSelection, resolveSelectionJob } from "./selection";
import { getState, queuePendingJob, removeTailoringJob, updateState, upsertTailoringJob } from "./storage";

interface TailorPayload {
  apiBaseUrl: string;
  aiProvider: AiProvider;
  profile: BaseProfile;
  job: JobDescription;
  tailoringEngine: TailoringEngine;
}

const DEEPSEEK_PROVIDER: AiProvider = "deepseek-api";

// MV3 reclaims idle service workers after ~30s; a lone in-flight fetch doesn't
// reliably keep the worker alive, so a long CCC run gets killed mid-request.
// Pinging a no-permission extension API every 20s (under the idle window) resets
// the worker's idle timer and keeps it alive for the duration of a tailor run.
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
function startKeepAlive() {
  if (keepAliveTimer) return; // defensive: never stack intervals
  keepAliveTimer = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20_000);
}
function stopKeepAliveIfIdle() {
  if (activeRuns.size === 0 && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// The in-flight tailoring runs, keyed by jobKey, so a Cancel message can abort
// the right one and multiple jobs can tailor at once (server enforces the
// actual concurrency cap; the client just tracks whatever it started).
const activeRuns = new Map<string, { controller: AbortController; startedAt: number }>();

// A "running" job left in storage after the service worker restarted can only
// be resumed by polling its server-side run id — the in-flight promise that
// was watching it died with the previous worker. Jobs without a run id yet
// (request never reached the server) can't be resumed; flip those to an error
// so the popup shows a reason instead of a permanent spinner.
async function reconcileOrphanedTailoring() {
  const state = await getState();
  for (const [jobKey, tj] of Object.entries(state.tailoringJobs)) {
    if (tj.status !== "running" && tj.status !== "queued") continue;
    if (!tj.runId) {
      await upsertTailoringJob(jobKey, { ...tj, status: "error", error: "Tailoring was interrupted. Please try again.", startedAt: 0 });
      continue;
    }
    const controller = new AbortController();
    const startedAt = tj.startedAt || Date.now();
    activeRuns.set(jobKey, { controller, startedAt });
    startKeepAlive();
    void monitorExistingRun(state.settings.apiBaseUrl, DEEPSEEK_PROVIDER, tj.runId, jobKey, startedAt, controller).catch(console.error);
  }
}

async function saveCompletedCv(cv: Awaited<ReturnType<typeof api.tailor>>, jobKey: string) {
  const record: ApplicationRecord = {
    id: makeId("application"),
    job: cv.job,
    tailoredCv: cv,
    status: "not-sent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await updateState((state) => ({
    ...state,
    tailoringJobs: { ...state.tailoringJobs, [jobKey]: { status: "done", error: "", cvId: cv.id, runId: cv.pipeline.runId, stage: "completed", progress: 100, jobKey, startedAt: 0 } },
    drafts: { ...state.drafts, [cv.id]: cv },
    applications: [record, ...state.applications]
  }));
  await chrome.action.setBadgeText({ text: "" });
}

async function monitorExistingRun(
  apiBaseUrl: string,
  aiProvider: AiProvider,
  runId: string,
  jobKey: string,
  startedAt: number,
  controller: AbortController
) {
  try {
    while (!controller.signal.aborted) {
      const run = await api.tailoringRun(apiBaseUrl, aiProvider, runId, controller.signal);
      if (run.status === "completed" && run.cv) {
        await saveCompletedCv(run.cv, jobKey);
        return;
      }
      if (run.status === "failed" || run.status === "cancelled") {
        await upsertTailoringJob(jobKey, { status: "error", error: run.error || `Tailoring ${run.status}`, cvId: "", runId, stage: run.stage, progress: run.progress, jobKey, startedAt: 0 });
        return;
      }
      await upsertTailoringJob(jobKey, { status: run.status === "queued" ? "queued" : "running", error: "", cvId: "", runId, stage: run.stage, progress: run.progress, jobKey, startedAt });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    activeRuns.delete(jobKey);
    stopKeepAliveIfIdle();
  }
}

function startTailoring(payload: TailorPayload): boolean {
  const jobKey = tailoringJobKey(payload.job);
  // Acquire this jobKey's lock synchronously, before any await, so two
  // messages delivered back-to-back for the same job can't both start it.
  if (activeRuns.has(jobKey)) return false;

  const startedAt = Date.now();
  const controller = new AbortController();
  activeRuns.set(jobKey, { controller, startedAt });
  startKeepAlive();
  void runTailoring(payload, jobKey, startedAt, controller).catch(console.error);
  return true;
}

async function runTailoring(payload: TailorPayload, jobKey: string, startedAt: number, controller: AbortController) {
  try {
    await upsertTailoringJob(jobKey, { status: "queued", error: "", cvId: "", runId: "", stage: "queued", progress: 0, jobKey, startedAt });
    const cv = await api.tailor(
      payload.apiBaseUrl,
      DEEPSEEK_PROVIDER,
      payload.profile,
      payload.job,
      payload.tailoringEngine,
      controller.signal,
      async (run) => {
        await upsertTailoringJob(jobKey, {
          status: run.status === "queued" ? "queued" : "running",
          error: "",
          cvId: "",
          runId: run.id,
          stage: run.stage,
          progress: run.progress,
          jobKey,
          startedAt
        });
      }
    );
    // The user cancelled while the request was in flight (the Cancel handler
    // aborts this controller and clears the slot). Discard the result so a CV
    // never appears for a run the user explicitly cancelled.
    if (controller.signal.aborted) return;
    await saveCompletedCv(cv, jobKey);
  } catch (cause) {
    // An aborted fetch is an intentional cancel, not a failure — exit quietly
    // (the Cancel handler already cleared the slot); never flash an error.
    if (controller.signal.aborted) return;
    await upsertTailoringJob(jobKey, { status: "error", error: (cause as Error).message, cvId: "", runId: "", stage: "", progress: 0, jobKey, startedAt: 0 });
  } finally {
    activeRuns.delete(jobKey);
    stopKeepAliveIfIdle();
  }
}

// Abort the in-flight tailoring for one job (if any) and clear its slot, so
// Cancel actually stops that job's network/AI work instead of letting it
// complete and create a CV. Other jobs keep tailoring undisturbed.
function cancelTailoring(jobKey: string) {
  void getState().then((state) => {
    const runId = state.tailoringJobs[jobKey]?.runId;
    if (runId) void api.cancelTailoringRun(state.settings.apiBaseUrl, state.settings.aiProvider, runId).catch(() => undefined);
  });
  activeRuns.get(jobKey)?.controller.abort();
  activeRuns.delete(jobKey);
  stopKeepAliveIfIdle();
  void removeTailoringJob(jobKey);
  void chrome.action.setBadgeText({ text: "" });
}

// Ask the page's content script for the job it scraped from the DOM. On a
// LinkedIn job page `scrapeLinkedIn` reads the real title/company/location far
// more reliably than the browser tab title; returns null off LinkedIn or when
// the content script isn't injected (the message rejects — caught here).
async function scrapeJobFromTab(tabId?: number): Promise<JobDescription | null> {
  if (tabId == null) return null;
  try {
    const job = await chrome.tabs.sendMessage(tabId, { type: "CV_TAILOR_SCRAPE_JOB" });
    return job && typeof job.title === "string" ? (job as JobDescription) : null;
  } catch {
    return null;
  }
}

const MENU_ID = "send-selection-to-cv-tailor";
let menuRegistration = Promise.resolve();

function createSelectionMenu() {
  menuRegistration = menuRegistration.then(() => new Promise<void>((resolve) => {
    chrome.contextMenus.remove(MENU_ID, () => {
      void chrome.runtime.lastError;
      chrome.contextMenus.create({
        id: MENU_ID,
        title: "Send selection to Fyxor",
        contexts: ["selection"]
      }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }));
}

createSelectionMenu();
// Runs on every fresh service-worker spin-up; recovers a job orphaned when a
// previous worker was terminated mid-tailoring.
reconcileOrphanedTailoring().catch(console.error);
chrome.runtime.onInstalled.addListener((details) => {
  createSelectionMenu();
  if (details.reason === "install") {
    // Open the gated root; unauthenticated users land on the sign-up screen,
    // then flow into onboarding after creating an account.
    chrome.tabs.create({ url: chrome.runtime.getURL("index.html") }).catch(console.error);
  }
});
chrome.runtime.onStartup.addListener(() => {
  createSelectionMenu();
  reconcileOrphanedTailoring().catch(console.error);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  const pageUrl = info.pageUrl || tab?.url || "";
  const fallback = jobFromSelection(info.selectionText, pageUrl, tab?.title || "");
  // Prefer the DOM-scraped title/company/location, but keep the user's explicit
  // selection as the description. A partial scrape (description found, title/company
  // empty) falls back to the text-parsed values instead of blanking the fields.
  const scraped = await scrapeJobFromTab(tab?.id);
  const job: JobDescription = resolveSelectionJob(scraped, fallback);
  await queuePendingJob(job);
  await chrome.action.setBadgeBackgroundColor({ color: "#059669" });
  try {
    await chrome.action.openPopup();
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    await chrome.action.setBadgeText({ text: "1" });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CV_TAILOR_START_TAILORING") {
    sendResponse({ ok: startTailoring(message.payload as TailorPayload) });
    return;
  }
  if (message?.type === "CV_TAILOR_CANCEL_TAILORING") {
    cancelTailoring(typeof message.jobKey === "string" ? message.jobKey : "");
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "CV_TAILOR_OPEN_FULL_PAGE") {
    const hash = typeof message.hash === "string" ? message.hash : "#tracker";
    chrome.tabs.create({ url: chrome.runtime.getURL(`index.html${hash}`) }).catch(console.error);
  }
});
