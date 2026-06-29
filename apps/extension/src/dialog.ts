import {
  makeId,
  type ApplicationRecord,
  type JobDescription,
  type StorageState,
  type TailoredCv
} from "@cv-tailor/shared";
import { api } from "./api";
import { getState, updateState } from "./storage";

type DialogView = "job" | "working" | "error";
type ScanState = "loading" | "ready" | "unsupported";
export function dialogJobSummary(job: JobDescription | null) {
  return {
    title: job?.title || "Waiting for job details",
    company: job?.company || "LinkedIn",
    ready: Boolean(job && job.description.length >= 20)
  };
}

export function createLinkedInDialog(onVisibilityChange?: (visible: boolean) => void, onRetry?: () => void) {
  const host = document.createElement("div");
  host.id = "cv-tailor-page-dialog";
  host.style.cssText = "position:fixed;right:20px;top:72px;z-index:2147483646;display:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .dialog {
        background: #fff;
        border: 1px solid #dfe5e2;
        border-radius: 20px;
        box-shadow: 0 24px 70px rgba(15,23,42,.24), 0 2px 5px rgba(15,23,42,.08);
        color: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        max-height: calc(100vh - 96px);
        overflow: auto;
        width: min(370px, calc(100vw - 32px));
      }
      header { align-items: center; border-bottom: 1px solid #edf0ee; display: flex; justify-content: space-between; padding: 14px 15px; }
      .brand { align-items: center; display: flex; gap: 9px; font-size: 13px; font-weight: 750; }
      .mark { align-items:center;background:linear-gradient(135deg,#10b981,#047857);border-radius:9px;color:#fff;display:flex;height:28px;justify-content:center;width:28px; }
      .close { background:transparent;border:0;border-radius:8px;color:#64748b;cursor:pointer;font-size:20px;height:30px;line-height:1;width:30px; }
      .close:hover { background:#f1f5f9;color:#0f172a; }
      main { padding: 15px; }
      .eyebrow { color:#047857;font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase; }
      h2 { font-size:17px;line-height:1.25;margin:5px 0 2px; }
      .company,.muted { color:#64748b;font-size:12px;line-height:1.45; }
      .preview { background:#f8fafc;border:1px solid #edf0ee;border-radius:12px;color:#475569;font-size:11px;line-height:1.45;margin-top:12px;max-height:78px;overflow:hidden;padding:10px; }
      .notice,.error { border-radius:12px;font-size:12px;line-height:1.45;margin-bottom:12px;padding:10px; }
      .notice { background:#ecfdf5;color:#065f46; }
      .error { background:#fef2f2;color:#b91c1c; }
      .actions { display:grid;gap:8px;margin-top:14px; }
      button.action { align-items:center;border-radius:11px;cursor:pointer;display:flex;font-size:12px;font-weight:750;justify-content:center;padding:10px 12px;transition:.15s ease; }
      button.action:disabled { cursor:not-allowed;opacity:.45; }
      .primary { background:#065f46;border:1px solid #065f46;color:#fff; }
      .primary:hover:not(:disabled) { background:#047857; }
      .secondary { background:#fff;border:1px solid #dfe5e2;color:#0f172a; }
      .secondary:hover:not(:disabled) { background:#f8fafc; }
      .link { background:transparent;border:0;color:#047857;cursor:pointer;font-size:11px;font-weight:700;padding:6px; }
      .spinner { animation:spin .8s linear infinite;border:2px solid #d1fae5;border-top-color:#047857;border-radius:999px;height:18px;width:18px; }
      .working { align-items:center;display:flex;gap:10px;padding:18px 0; }
      @keyframes spin { to { transform:rotate(360deg); } }
      @media(max-width:640px){#root{right:12px}.dialog{width:calc(100vw - 24px)}}
    </style>
    <section class="dialog" role="dialog" aria-label="Fyxor">
      <header><span class="brand"><span class="mark">✓</span> Fyxor</span><button class="close" aria-label="Close">×</button></header>
      <main></main>
    </section>
  `;
  const main = shadow.querySelector("main")!;
  const close = shadow.querySelector(".close")!;
  let job: JobDescription | null = null;
  let state: StorageState | null = null;
  let view: DialogView = "job";
  let message = "";
  let scanState: ScanState = "loading";
  let scanReason = "Reading LinkedIn job details.";

  (document.body || document.documentElement).appendChild(host);
  close.addEventListener("click", () => hide());

  function escape(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[character] || character));
  }

  function openFullPage(hash: string) {
    chrome.runtime.sendMessage({ type: "CV_TAILOR_OPEN_FULL_PAGE", hash }).catch(() => undefined);
  }

  async function refreshState() {
    state = await getState();
    render();
  }

  async function saveGeneratedCv(cv: TailoredCv) {
    if (!job) return;
    const record: ApplicationRecord = {
      id: makeId("application"), job, tailoredCv: cv, status: "not-sent",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await updateState((current) => ({
      ...current,
      drafts: { ...current.drafts, [cv.id]: cv },
      applications: [record, ...current.applications]
    }));
    openFullPage(`#editor/${cv.id}`);
    hide();
  }

  async function generate() {
    if (!state?.profile || !job) return;
    view = "working"; message = "Tailoring your CV…"; render();
    try {
      const cv = await api.tailor(state.settings.apiBaseUrl, state.settings.aiProvider, state.profile, job, state.settings.tailoringEngine);
      await saveGeneratedCv(cv);
    } catch (error) {
      view = "error"; message = (error as Error).message; render();
    }
  }

  function render() {
    const summary = dialogJobSummary(job);
    if (!state) {
      main.innerHTML = `<div class="working"><span class="spinner"></span><span class="muted">Loading Fyxor…</span></div>`;
      return;
    }
    if (!state.settings.onboardingComplete || !state.profile) {
      main.innerHTML = `<div class="notice">Set up your base CV once, then tailor job offers from this small dialog.</div>
        <div class="actions"><button class="action primary" data-action="setup">Start onboarding</button></div>`;
    } else if (view === "working") {
      main.innerHTML = `<div class="working"><span class="spinner"></span><span class="muted">${escape(message)}</span></div>`;
    } else if (view === "error") {
      main.innerHTML = `<div class="error">${escape(message)}</div><div class="actions"><button class="action secondary" data-action="back">Back</button></div>`;
    } else if (scanState === "unsupported" && !job) {
      main.innerHTML = `<div class="eyebrow">Unable to read this LinkedIn layout</div>
        <h2>Select the job description</h2>
        <div class="error">${escape(scanReason)}</div>
        <div class="actions"><button class="action primary" data-action="retry">Retry detection</button><button class="link" data-action="tracker">Open tracker</button></div>`;
    } else {
      const jobStatus = job?.source === "linkedin"
        ? (summary.ready ? "LinkedIn job detected" : "Reading LinkedIn job")
        : (summary.ready ? "Job offer imported" : "Reading job offer");
      main.innerHTML = `<div class="eyebrow">${jobStatus}</div>
        <h2>${escape(summary.title)}</h2><div class="company">${escape(summary.company)}</div>
        <div class="preview">${escape(job?.description || scanReason)}</div>
        <div class="actions">
          <button class="action primary" data-action="generate" ${summary.ready ? "" : "disabled"}>Generate tailored CV</button>
          <button class="link" data-action="tracker">Open tracker</button>
        </div>`;
    }
    main.querySelector('[data-action="setup"]')?.addEventListener("click", () => openFullPage("#onboarding"));
    main.querySelector('[data-action="tracker"]')?.addEventListener("click", () => openFullPage("#tracker"));
    main.querySelector('[data-action="generate"]')?.addEventListener("click", generate);
    main.querySelector('[data-action="back"]')?.addEventListener("click", () => { view = "job"; render(); });
    main.querySelector('[data-action="retry"]')?.addEventListener("click", () => {
      scanState = "loading";
      scanReason = "Reading LinkedIn job details.";
      render();
      onRetry?.();
    });
  }

  function show() {
    host.style.display = "block";
    onVisibilityChange?.(true);
    refreshState();
  }

  function hide() {
    host.style.display = "none";
    onVisibilityChange?.(false);
  }

  return {
    toggle() {
      host.style.display === "none" ? show() : hide();
    },
    show,
    hide,
    setJob(nextJob: JobDescription | null) {
      job = nextJob;
      view = "job";
      if (nextJob) scanState = "ready";
      if (host.style.display !== "none") render();
    },
    setScanState(nextState: ScanState, reason?: string) {
      scanState = nextState;
      scanReason = reason || scanReason;
      if (nextState !== "ready") job = null;
      if (host.style.display !== "none") render();
    }
  };
}
