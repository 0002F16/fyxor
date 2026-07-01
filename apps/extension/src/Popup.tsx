import { useEffect, useState } from "react";
import { ArrowLeft, Check, ExternalLink, Home, LayoutDashboard, LoaderCircle, Sparkles } from "lucide-react";
import { activeTailoringForJobs, selectPopupView } from "./popupView";
import {
  activeTailoringJobs,
  migrateStorage,
  tailoringJobKey,
  type JobDescription,
  type StorageState,
} from "@cv-tailor/shared";
import { useTailorFlavor } from "./tailorFlavor";
import { TailorRunCard } from "./TailorRunCard";
import { clearPendingJob, getState, queuePendingJob, removeTailoringJob, upsertTailoringJob } from "./storage";
import type { LinkedInScanResult } from "./scraper";
import { sendLinkedInMessage } from "./linkedinMessaging";

// A running tailoring job older than this was almost certainly orphaned by a
// terminated MV3 service worker. Must stay greater than the client backstop
// timeout (api.ts TAILOR_TIMEOUT_MS, 15 min) so a still-running healthy job
// isn't falsely flagged as orphaned; matches background STALE_TAILORING_MS.
const STALE_MS = 16 * 60 * 1000;

// Defense-in-depth: the API already sanitizes tailoring-run errors, but a stale
// raw (JSON-ish) error can linger in chrome.storage from a previous version.
// Never render a technical-looking blob to the user.
function showError(raw?: string): string | undefined {
  if (!raw) return raw;
  const trimmed = raw.trim();
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? "We couldn't finish tailoring this CV. Please try again."
    : raw;
}

function Logo() {
  return <span className="popup-logo"><Check size={18} strokeWidth={3} /></span>;
}

function openFullPage(hash: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`index.html${hash}`) });
}

async function getLinkedInScan() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.match(/^https:\/\/(?:[^./]+\.)?linkedin\.com\/jobs(?:\/|$)/i)) return null;
  return sendLinkedInMessage<LinkedInScanResult>(tab.id, { type: "CV_TAILOR_SCAN_LINKEDIN" });
}

async function waitForLinkedInScan() {
  let result = await getLinkedInScan();
  for (let attempt = 0; result?.status === "loading" && attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    result = await getLinkedInScan();
  }
  return result;
}

export function Popup() {
  const [state, setState] = useState<StorageState | null>(null);
  const [job, setJob] = useState<JobDescription | null>(null);
  const [error, setError] = useState("");
  const [linkedinScan, setLinkedinScan] = useState<LinkedInScanResult | null>(null);
  const [startingTailoring, setStartingTailoring] = useState(false);

  useEffect(() => {
    Promise.all([getState(), waitForLinkedInScan()]).then(([stored, scan]) => {
      // A "running"/"queued" job older than the watchdog window was orphaned by
      // a terminated service worker — surface it as an error instead of a
      // spinner the user can never escape.
      const tailoringJobs = { ...stored.tailoringJobs };
      for (const [key, tj] of Object.entries(tailoringJobs)) {
        if ((tj.status === "running" || tj.status === "queued") && Date.now() - (tj.startedAt || 0) > STALE_MS) {
          const errored = { status: "error" as const, error: "Tailoring took too long or was interrupted. Please try again.", cvId: "", runId: tj.runId, stage: "", progress: 0, jobKey: tj.jobKey, startedAt: 0 };
          tailoringJobs[key] = errored;
          void upsertTailoringJob(key, errored);
        }
      }
      stored = { ...stored, tailoringJobs };
      setState(stored);
      setLinkedinScan(scan);
      setJob(stored.pendingJob || (scan?.status === "ready" ? scan.job : null));
      chrome.action.setBadgeText({ text: "" });
    });
  }, []);

  // Keep in sync with background tailoring progress without polling
  useEffect(() => {
    const KEY = "cvTailorState";
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (!changes[KEY]) return;
      setState(migrateStorage(changes[KEY].newValue));
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  async function retryLinkedIn() {
    setLinkedinScan({ status: "loading", identity: linkedinScan?.identity || "", reason: "Reading LinkedIn job details." });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await sendLinkedInMessage(tab.id, { type: "CV_TAILOR_RETRY_LINKEDIN" });
    const scan = await waitForLinkedInScan();
    setLinkedinScan(scan);
    if (scan?.status === "ready") setJob(scan.job);
  }

  // Navigate back to job selection WITHOUT touching any in-flight tailoring —
  // with several tailors able to run at once, leaving this job's screen must
  // not cancel its run; the user can come back later and find it done.
  async function goBack() {
    const next = await clearPendingJob();
    setState(next);
    setJob(null);
    setError("");
    chrome.action.setBadgeText({ text: "" });
  }

  // Explicit Cancel while this job is tailoring: abort just this job's run in
  // the background (otherwise it completes and a CV appears despite the
  // cancel), then navigate back.
  async function cancelCurrentJob() {
    const jobKey = job ? tailoringJobKey(job) : "";
    if (jobKey) chrome.runtime.sendMessage({ type: "CV_TAILOR_CANCEL_TAILORING", jobKey }).catch(() => {});
    await goBack();
  }

  // Edit the captured title/company before tailoring. Local state drives generate();
  // the blur persist keeps the correction if the popup is reopened.
  function editJob(patch: Partial<JobDescription>) {
    setJob((current) => (current ? { ...current, ...patch } : current));
  }
  function persistJob() {
    if (job) void queuePendingJob(job);
  }

  async function generate() {
    if (!state?.profile || !job || startingTailoring) return;
    setError("");
    // The background worker owns the persisted running slot. Persisting an
    // optimistic slot here used to make the worker mistake the first click for
    // a duplicate and return before calling the API, leaving an endless spinner.
    // This local flag gives immediate feedback until the worker publishes the
    // authoritative running state.
    setStartingTailoring(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CV_TAILOR_START_TAILORING",
        payload: {
          apiBaseUrl: state.settings.apiBaseUrl,
          aiProvider: state.settings.aiProvider,
          profile: state.profile,
          job,
          tailoringEngine: state.settings.tailoringEngine
        }
      });
      if (!response?.ok) setError("This job is already tailoring.");
    } catch {
      setError("Couldn't reach the extension background. Please try again.");
    } finally {
      setStartingTailoring(false);
    }
  }

  const tailoringJobs = state?.tailoringJobs ?? {};
  // Only the tailoring slot that belongs to the job on screen governs the main
  // card (see activeTailoringForJobs) — a finished/old job must not hijack the
  // UI for a different, freshly selected job.
  const activeTailoring = activeTailoringForJobs(tailoringJobs, job);
  const busy = startingTailoring || activeTailoring?.status === "running" || activeTailoring?.status === "queued";
  const queued = !startingTailoring && activeTailoring?.status === "queued";
  const flavor = useTailorFlavor(busy && !queued, job ? tailoringJobKey(job).length : 0);
  const tailorStage = queued ? "Waiting for a free lane…" : flavor;

  // Other jobs tailoring in the background, so the popup shows the full
  // picture even while looking at a different job.
  const otherRuns = Object.entries(tailoringJobs).filter(([key, tj]) =>
    key !== (job ? tailoringJobKey(job) : "") && (tj.status === "running" || tj.status === "queued")
  );
  const totalActive = activeTailoringJobs({ tailoringJobs }).length;

  if (!state) return <div className="popup-loading"><LoaderCircle className="animate-spin" size={18} /> Loading Fyxor...</div>;

  const view = selectPopupView(state, job, linkedinScan);
  const scanReason = linkedinScan && "reason" in linkedinScan ? linkedinScan.reason : "";

  return <div className="popup-shell">
    <header className="popup-header">
      <div className="popup-brand"><Logo /><span>Fyxor</span></div>
      {job && <button className="popup-icon-button" aria-label="Adjust another resume" onClick={goBack}><ArrowLeft size={18} /></button>}
    </header>

    {/* Other jobs tailoring in the background — visible from any screen so the
        user always sees the full picture, not just the job on screen. */}
    {otherRuns.length > 0 && <div className="popup-other-runs space-y-2 px-4 pt-3">
      {otherRuns.map(([key, tj]) => (
        <TailorRunCard key={key} job={tj} onOpen={(cvId) => openFullPage(`#editor/${cvId}`)} />
      ))}
    </div>}

    {view === "signed-out" ? <main className="popup-main popup-centered">
      <p className="popup-eyebrow">Welcome to Fyxor</p>
      <h1>Sign in to use Fyxor</h1>
      <p>Create an account or sign in to tailor your CV. Your resume and applications sync to your account.</p>
      <button className="popup-primary" onClick={() => openFullPage("")}><Sparkles size={16} /> Sign in or create account</button>
    </main> : view === "linkedin-loading" ? <main className="popup-main popup-centered">
      <p className="popup-eyebrow">LinkedIn job selected</p>
      <h1>Reading job details</h1>
      <div className="popup-busy"><LoaderCircle className="animate-spin" size={17} /> {scanReason}</div>
      <button className="popup-secondary" onClick={retryLinkedIn}>Retry detection</button>
    </main> : view === "linkedin-unsupported" ? <main className="popup-main popup-centered">
      <p className="popup-eyebrow">Unable to read this LinkedIn layout</p>
      <h1>Select the job description</h1>
      <p>{scanReason}</p>
      <button className="popup-primary" onClick={retryLinkedIn}>Retry detection</button>
    </main> : view === "new-user" ? <main className="popup-main popup-centered">
      <p className="popup-eyebrow">Welcome to Fyxor</p>
      <h1>You're one step from a CV that works</h1>
      <p>Start by creating your base CV — upload an existing file or use our resume creator. Then tailor it to any job offer in a couple of clicks.</p>
      <button className="popup-primary" onClick={() => openFullPage("#onboarding")}><Sparkles size={16} /> Create your CV</button>
    </main> : view === "no-job" ? <main className="popup-main popup-centered">
      <p className="popup-eyebrow">Tailor from any website</p>
      <h1>Adjust another resume</h1>
      <p>Highlight the job offer, right-click, and select <strong>Send selection to Fyxor</strong> to get a CV tailored to the offer.</p>
      <video className="popup-demo" autoPlay loop muted playsInline aria-label="Demonstration of highlighting a job description and sending it to Fyxor">
        <source src="/selection-demo.webm" type="video/webm" />
      </video>
      <button className="popup-link" onClick={() => openFullPage("")}><Home size={14} /> Go to dashboard</button>
    </main> : view === "build-cv" ? <main className="popup-main popup-centered">
      <p className="popup-eyebrow">Job offer imported</p>
      <h1>Build your base CV</h1>
      <p>Set up your verified experience before tailoring this job offer.</p>
      <button className="popup-primary" onClick={() => openFullPage("#onboarding")}>Start onboarding</button>
    </main> : <main className="popup-main">
      <p className="popup-eyebrow">{job?.source === "linkedin" ? "LinkedIn job detected" : "Job offer imported"}</p>
      {busy || activeTailoring?.status === "done" ? <>
        <h1>{job?.title || "Selected job offer"}</h1>
        <p className="popup-company">{job?.company}</p>
      </> : <div className="popup-edit">
        <label className="popup-edit-label">Job title</label>
        <input className="popup-edit-input is-title" value={job?.title || ""} placeholder="Job title"
          onChange={(e) => editJob({ title: e.target.value })} onBlur={persistJob} />
        <input className="popup-edit-input is-company" value={job?.company || ""} placeholder="Employer"
          onChange={(e) => editJob({ company: e.target.value })} onBlur={persistJob} />
      </div>}
      <div className="popup-preview">{job?.description}</div>
      {(error || activeTailoring?.error) && <div className="popup-error">{showError(error || activeTailoring?.error)}</div>}
      {activeTailoring?.status === "done" ? <div className="popup-actions">
        <button className="popup-primary" onClick={() => { openFullPage(`#editor/${activeTailoring.cvId}`); if (job) void removeTailoringJob(tailoringJobKey(job)); }}><ExternalLink size={16} /> Open your tailored CV</button>
        <button className="popup-link" onClick={goBack}><ArrowLeft size={14} /> Adjust another resume</button>
      </div> : busy ? <div className="popup-progress">
        <div className="popup-busy"><LoaderCircle className="animate-spin" size={17} /> {tailorStage}</div>
        <p className="popup-progress-note">
          {queued ? "It'll start automatically as soon as a lane frees up." : "Tailoring can take a minute or two — feel free to close this popup."}
          {totalActive > 1 ? ` (${totalActive} tailoring right now)` : ""}
        </p>
        <button className="popup-link" onClick={cancelCurrentJob}>Cancel</button>
      </div> : <div className="popup-actions">
        <button className="popup-primary" onClick={generate}><Sparkles size={16} /> Generate tailored CV</button>
        <button className="popup-link" onClick={goBack}><ArrowLeft size={14} /> Adjust another resume</button>
      </div>}
    </main>}

    {job && <footer><button className="popup-link" onClick={() => openFullPage("#tracker")}><LayoutDashboard size={14} /> Open tracker</button></footer>}
  </div>;
}
