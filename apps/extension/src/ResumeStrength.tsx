import { useState } from "react";
import { CheckCircle2, ChevronDown, Info, Sparkles, X } from "lucide-react";
import type { ResumeStrength as Strength } from "./resumeChecks";

// Sticky sidebar card that flags what's missing from a resume. Shows a weighted
// completeness score with a progress bar, then a collapsible checklist of the
// outstanding suggestions. Each item carries a how-to tooltip and a dismiss
// button so the user can forcefully ignore any suggestion.
export function ResumeStrength({ strength, onDismiss, onHide }: {
  strength: Strength;
  onDismiss: (id: string) => void;
  onHide: () => void;
}) {
  const [open, setOpen] = useState(true);
  const complete = strength.checks.length === 0;

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles size={16} className="text-emerald" /> Resume strength
        </div>
        <span className={`text-sm font-bold ${complete ? "text-emerald" : "text-deep"}`}>{strength.score}%</span>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-emerald transition-all duration-300" style={{ width: `${strength.score}%` }} />
      </div>

      {complete ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald"><CheckCircle2 size={16} /> Looks strong — nothing left to flag.</p>
      ) : (
        <>
          <button className="mt-3 flex w-full items-center justify-between text-left text-xs font-semibold text-muted hover:text-ink" onClick={() => setOpen(!open)}>
            <span>{strength.checks.length} suggestion{strength.checks.length === 1 ? "" : "s"} to improve it</span>
            <ChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open && <ul className="mt-2 space-y-1.5">
            {strength.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2 text-sm">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${check.severity === "required" ? "bg-red-500" : "bg-amber-400"}`} aria-hidden />
                <span className="flex-1 text-ink">{check.label}</span>
                <span className="shrink-0 text-muted" title={check.detail} aria-label={check.detail}><Info size={13} /></span>
                <button className="shrink-0 text-muted hover:text-red-500" aria-label={`Ignore: ${check.label}`} onClick={() => onDismiss(check.id)}><X size={14} /></button>
              </li>
            ))}
          </ul>}
        </>
      )}

      <button className="mt-3 text-xs font-medium text-muted hover:text-ink hover:underline" onClick={onHide}>Hide tips</button>
    </div>
  );
}
