import { AlertTriangle, FilePenLine, LoaderCircle, X } from "lucide-react";
import type { TailoringJob } from "@cv-tailor/shared";
import { useTailorFlavor } from "./tailorFlavor";

// Small stable hash so each job's card starts on a different playful phrase
// (and stays consistent across re-renders) without needing shared state.
function seedFor(jobKey: string): number {
  let hash = 0;
  for (let i = 0; i < jobKey.length; i += 1) hash = (hash * 31 + jobKey.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

// Defense-in-depth: the API already sanitizes tailoring-run errors, but a stale
// raw (JSON-ish) error can linger in chrome.storage from a previous version.
function friendlyError(raw?: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "Something interrupted this run. Try again.";
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? "Something went wrong on our end. Please try tailoring again."
    : trimmed;
}

// One card per tailoring run — used stacked on Home and in the popup so users
// can watch several tailors at once. The progress bar is driven by the real
// server progress; only the label cycles through playful copy, so the UI
// never overclaims completeness while still feeling alive.
export function TailorRunCard({
  job,
  title,
  onOpen,
  onCancel,
  onDismiss
}: {
  job: TailoringJob;
  title?: string;
  onOpen?: (cvId: string) => void;
  onCancel?: () => void;
  onDismiss?: () => void;
}) {
  const seed = seedFor(job.jobKey);
  const flavor = useTailorFlavor(job.status === "running" || job.status === "queued", seed);

  if (job.status === "error") {
    return <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 gap-2 text-sm font-semibold">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className="truncate">{title || "Tailoring didn't finish"}</span>
        </div>
        {onDismiss && <button className="shrink-0 text-amber-700 hover:text-amber-950" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>}
      </div>
      <p className="mt-1 text-xs">{friendlyError(job.error)}</p>
      {!!job.cvId && onOpen && <button className="btn-secondary mt-3 !bg-white text-xs" onClick={() => onOpen(job.cvId)}><FilePenLine size={13} /> Open last draft</button>}
    </div>;
  }

  const queued = job.status === "queued";
  return <div className="card border-emerald bg-mint/30 !p-4">
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <LoaderCircle size={16} className="shrink-0 animate-spin text-deep" />
        <div className="min-w-0">
          {title && <p className="truncate text-xs font-semibold uppercase tracking-[.08em] text-emerald">{title}</p>}
          <p className="truncate text-sm font-semibold text-deep">{queued ? "Waiting for a free lane…" : flavor}</p>
        </div>
      </div>
      {onCancel && <button className="shrink-0 text-muted hover:text-deep" onClick={onCancel} aria-label="Cancel this tailor"><X size={14} /></button>}
    </div>
    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/70">
      <div
        className={`h-full rounded-full bg-emerald transition-all ${queued ? "animate-pulse" : ""}`}
        style={{ width: `${queued ? 20 : Math.max(5, job.progress)}%` }}
      />
    </div>
  </div>;
}
