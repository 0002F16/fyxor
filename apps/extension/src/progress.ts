import { useEffect, useState } from "react";

// Stages shown during the long, non-streaming tailor call so the user sees
// perceived progress instead of one indefinite spinner.
export const TAILOR_STAGES = [
  "Analyzing the job…",
  "Matching your experience…",
  "Drafting your CV…",
  "Final checks…"
];

// Returns the index a staged-progress sequence should be on after `elapsedMs`
// of work, advancing one stage every `intervalMs` and clamping at the last
// stage so it never claims to finish before the real response arrives.
export function stageIndexAt(elapsedMs: number, stageCount: number, intervalMs: number): number {
  if (stageCount <= 0) return 0;
  const raw = Math.floor(Math.max(0, elapsedMs) / intervalMs);
  return Math.min(raw, stageCount - 1);
}

// Advances through `stages` on a fixed interval while `active`, clamping at the
// final stage. Resets to the first stage whenever `active` flips back on.
export function useStagedProgress(active: boolean, stages: string[], intervalMs = 6000): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) { setIndex(0); return; }
    setIndex(0);
    const timer = setInterval(() => setIndex((i) => stageIndexAt((i + 1) * intervalMs, stages.length, intervalMs)), intervalMs);
    return () => clearInterval(timer);
  }, [active, stages.length, intervalMs]);
  return stages[Math.min(index, stages.length - 1)] ?? "";
}
