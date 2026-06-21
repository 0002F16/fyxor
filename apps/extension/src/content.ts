import { hasLinkedInJobContext, linkedInJobId, scanLinkedIn, type LinkedInScanResult } from "./scraper";
import { createLinkedInIndicator } from "./indicator";
import { createLinkedInDialog } from "./dialog";
import { nextScanDelay, shouldAcceptScan } from "./scanLifecycle";

declare global {
  interface Window {
    __cvTailorLinkedInLoaded?: boolean;
  }
}

if (!window.__cvTailorLinkedInLoaded) {
  window.__cvTailorLinkedInLoaded = true;
  startLinkedInScanner();
}

function startLinkedInScanner() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let lastIdentity = linkedInJobId(location.href, document);
  let lastSignature = "";
  let lastResult: LinkedInScanResult = scanLinkedIn();

  let indicator: ReturnType<typeof createLinkedInIndicator>;
  const dialog = createLinkedInDialog((visible) => indicator.setVisible(!visible), () => scheduleScan(true));
  indicator = createLinkedInIndicator(() => dialog.toggle());

  function applyResult(result: LinkedInScanResult) {
    lastResult = result;
    if (result.status === "ready") {
      dialog.setJob(result.job);
      dialog.setScanState("ready");
      indicator.update("detected", result.job);
      const signature = `${result.identity}:${result.job.title}:${result.job.company}:${result.job.description.slice(0, 120)}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        chrome.runtime.sendMessage({ type: "CV_TAILOR_LINKEDIN_JOB_UPDATED", job: result.job }).catch(() => undefined);
      }
      return;
    }
    dialog.setScanState(result.status, result.reason);
    indicator.update(result.status === "unsupported"
      ? "unsupported"
      : hasLinkedInJobContext() ? "job-selected" : "scanning");
  }

  function runScan(scanGeneration: number) {
    timer = undefined;
    if (scanGeneration !== generation) return;
    const identityBefore = linkedInJobId(location.href, document);
    const result = scanLinkedIn(document, location.href, attempt >= 12);
    const identityAfter = linkedInJobId(location.href, document);
    if (!shouldAcceptScan(identityBefore, identityAfter, scanGeneration, generation)) {
      scheduleScan(true);
      return;
    }
    applyResult(result);
    if (result.status === "loading") {
      attempt += 1;
      timer = setTimeout(() => runScan(scanGeneration), nextScanDelay(attempt));
    }
  }

  function scheduleScan(reset = false) {
    const identity = linkedInJobId(location.href, document);
    const identityChanged = identity !== lastIdentity;
    if (reset || identityChanged) {
      lastIdentity = identity;
      attempt = 0;
      generation += 1;
      lastSignature = "";
    }
    if (timer && !reset && !identityChanged) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => runScan(generation), 180);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CV_TAILOR_SHOW_JOB_DIALOG" && message.job) {
      dialog.setJob(message.job);
      dialog.show();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "CV_TAILOR_TOGGLE_DIALOG") {
      dialog.toggle();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "CV_TAILOR_RETRY_LINKEDIN") {
      scheduleScan(true);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "CV_TAILOR_SCAN_LINKEDIN") {
      const result = scanLinkedIn(document, location.href, lastResult.status === "unsupported");
      sendResponse(result);
      return;
    }
    if (message?.type === "CV_TAILOR_SCRAPE_JOB") {
      sendResponse(lastResult.status === "ready" ? lastResult.job : null);
    }
  });

  new MutationObserver(() => scheduleScan()).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener("popstate", () => scheduleScan(true));
  setInterval(() => scheduleScan(linkedInJobId(location.href, document) !== lastIdentity), 1500);
  scheduleScan(true);
}
