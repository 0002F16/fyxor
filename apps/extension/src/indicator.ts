import type { JobDescription } from "@cv-tailor/shared";

export type IndicatorStatus = "scanning" | "job-selected" | "detected" | "unsupported";

export function indicatorCopy(status: IndicatorStatus, job?: JobDescription | null) {
  if (status === "detected") {
    return {
      label: "Tailor CV",
      detail: job?.title || "Ready to tailor",
      tone: "detected"
    };
  }
  if (status === "unsupported") {
    return {
      label: "Select job text",
      detail: "LinkedIn layout not supported",
      tone: "idle"
    };
  }
  if (status === "job-selected") {
    return {
      label: "Fyxor",
      detail: "Reading job details…",
      tone: "scanning"
    };
  }
  return {
    label: "Fyxor active",
    detail: "Reading this page…",
    tone: "scanning"
  };
}

export function createLinkedInIndicator(onOpen: () => void) {
  const host = document.createElement("div");
  host.id = "cv-tailor-page-indicator";
  host.style.cssText = "position:fixed;right:20px;top:72px;z-index:2147483647;transition:opacity .15s ease,transform .15s ease;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      button {
        appearance: none;
        align-items: center;
        background: rgba(255,255,255,.97);
        border: 1px solid #dfe5e2;
        border-radius: 999px;
        box-shadow: 0 10px 30px rgba(15,23,42,.16), 0 1px 2px rgba(15,23,42,.08);
        color: #0f172a;
        cursor: pointer;
        display: flex;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        gap: 8px;
        max-width: 180px;
        padding: 7px 11px 7px 7px;
        text-align: left;
        transition: box-shadow .18s ease, transform .18s ease;
      }
      button:hover { box-shadow: 0 14px 36px rgba(15,23,42,.22); transform: translateY(-1px); }
      button:focus-visible { outline: 2px solid #059669; outline-offset: 3px; }
      .mark {
        align-items: center;
        background: linear-gradient(135deg, #10b981, #047857);
        border-radius: 999px;
        color: white;
        display: flex;
        flex: 0 0 auto;
        height: 28px;
        justify-content: center;
        width: 28px;
      }
      .label { color: #065f46; display: block; font-size: 12px; font-weight: 750; line-height: 1.2; white-space: nowrap; }
      .dot { background: #94a3b8; border-radius: 999px; height: 7px; margin-left: auto; width: 7px; }
      button[data-tone="detected"] .dot { background: #10b981; box-shadow: 0 0 0 4px rgba(16,185,129,.14); }
      button[data-tone="scanning"] .dot { animation: pulse 1.2s ease-in-out infinite; background: #10b981; }
      @keyframes pulse { 50% { opacity: .3; transform: scale(.75); } }
    </style>
    <button type="button" aria-label="Open Fyxor dialog" data-tone="scanning">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.2 4.2L19 7"/></svg>
      </span>
      <span class="label"></span>
      <span class="dot" aria-hidden="true"></span>
    </button>
  `;
  const button = shadow.querySelector("button")!;
  const label = shadow.querySelector(".label")!;
  let current = "";

  button.addEventListener("click", onOpen);
  (document.body || document.documentElement).appendChild(host);

  return {
    update(status: IndicatorStatus, job?: JobDescription | null) {
      const copy = indicatorCopy(status, job);
      const signature = `${copy.tone}:${copy.label}:${copy.detail}`;
      if (signature === current) return;
      current = signature;
      button.setAttribute("data-tone", copy.tone);
      label.textContent = copy.label;
      button.title = copy.detail;
      button.setAttribute("aria-label", status === "detected"
        ? `Open Fyxor for ${copy.detail}`
        : "Open Fyxor dialog");
    },
    setVisible(visible: boolean) {
      host.style.opacity = visible ? "1" : "0";
      host.style.pointerEvents = visible ? "auto" : "none";
      host.style.transform = visible ? "translateY(0)" : "translateY(-4px)";
    }
  };
}
