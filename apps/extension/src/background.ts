import { makeId, tailoringJobKey, type ApplicationRecord, type AiProvider, type BaseProfile, type JobDescription, type TailoringEngine } from "@cv-tailor/shared";
import { api } from "./api";
import { jobFromSelection } from "./selection";
import { getState, queuePendingJob, setTailoringJob, updateState } from "./storage";

interface TailorPayload {
  apiBaseUrl: string;
  aiProvider: AiProvider;
  profile: BaseProfile;
  job: JobDescription;
  tailoringEngine: TailoringEngine;
}

// MV3 reclaims idle service workers after ~30s; a lone in-flight fetch doesn't
// reliably keep the worker alive, so a long CCC run gets killed mid-request.
// Pinging a no-permission extension API every 20s (under the idle window) resets
// the worker's idle timer and keeps it alive for the duration of a tailor run.
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
function startKeepAlive() {
  if (keepAliveTimer) return; // defensive: never stack intervals
  keepAliveTimer = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20_000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// A "running" job left in storage after the service worker restarted can only
// be an orphan — its in-flight promise died with the previous worker. Flip it
// to an error so the popup shows a reason instead of a permanent spinner.
async function reconcileOrphanedTailoring() {
  const state = await getState();
  if (state.tailoringJob?.status === "running") {
    await setTailoringJob({ status: "error", error: "Tailoring was interrupted. Please try again.", cvId: "", jobKey: state.tailoringJob.jobKey, startedAt: 0 });
  }
}

// The in-flight tailoring run, so a Cancel message can abort its fetch. Only one
// runs at a time (enforced by the single-flight guard below).
let activeRun: { controller: AbortController; startedAt: number } | null = null;

function startTailoring(payload: TailorPayload): boolean {
  // Only an actual in-memory run is authoritative. The popup may have UI state
  // in storage, but treating that as an active request drops the first click
  // before fetch() ever runs. Acquire this lock synchronously, before any await,
  // so two messages delivered back-to-back cannot both start.
  if (activeRun) return false;

  const jobKey = tailoringJobKey(payload.job);
  const startedAt = Date.now();
  const controller = new AbortController();
  activeRun = { controller, startedAt };
  startKeepAlive();
  void runTailoring(payload, jobKey, startedAt, controller).catch(console.error);
  return true;
}

async function runTailoring(payload: TailorPayload, jobKey: string, startedAt: number, controller: AbortController) {
  try {
    await setTailoringJob({ status: "running", error: "", cvId: "", jobKey, startedAt });
    const cv = await api.tailor(payload.apiBaseUrl, payload.aiProvider, payload.profile, payload.job, payload.tailoringEngine, controller.signal);
    // The user cancelled while the request was in flight (the Cancel handler
    // aborts this controller and clears the slot). Discard the result so a CV
    // never appears for a run the user explicitly cancelled.
    if (controller.signal.aborted) return;
    const record: ApplicationRecord = {
      id: makeId("application"),
      job: payload.job,
      tailoredCv: cv,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await updateState((s) => ({
      ...s,
      pendingJob: null,
      tailoringJob: { status: "done", error: "", cvId: cv.id, jobKey, startedAt: 0 },
      drafts: { ...s.drafts, [cv.id]: cv },
      applications: [record, ...s.applications]
    }));
    await chrome.action.setBadgeText({ text: "" });
  } catch (cause) {
    // An aborted fetch is an intentional cancel, not a failure — exit quietly
    // (the Cancel handler already cleared the slot); never flash an error.
    if (controller.signal.aborted) return;
    await setTailoringJob({ status: "error", error: (cause as Error).message, cvId: "", jobKey, startedAt: 0 });
  } finally {
    if (activeRun?.startedAt === startedAt) activeRun = null;
    stopKeepAlive();
  }
}

// Abort the in-flight tailoring (if any) and clear the slot, so Cancel actually
// stops the network/AI work instead of letting it complete and create a CV.
function cancelTailoring() {
  activeRun?.controller.abort();
  activeRun = null;
  stopKeepAlive();
  void setTailoringJob(null);
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
  // selection as the description (it's what they chose to send).
  const scraped = await scrapeJobFromTab(tab?.id);
  const job: JobDescription = scraped
    ? { ...scraped, description: info.selectionText.trim(), url: pageUrl }
    : fallback;
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
    cancelTailoring();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "CV_TAILOR_OPEN_FULL_PAGE") {
    const hash = typeof message.hash === "string" ? message.hash : "#tracker";
    chrome.tabs.create({ url: chrome.runtime.getURL(`index.html${hash}`) }).catch(console.error);
  }
});
