import { tailoringJobKey, type JobDescription, type StorageState, type TailoringJob } from "@cv-tailor/shared";
import type { LinkedInScanResult } from "./scraper";

// Resolves the tailoring slot that actually governs the popup for the job on
// screen. A stored running/done/error slot only applies when it belongs to the
// current job (or when no job is selected — the just-finished happy path).
// Otherwise a finished/old job would hijack the UI for a different, freshly
// selected job, hiding its Generate button (and the only escape would discard
// the new job). Returns null when the slot belongs to a different job.
export function activeTailoringFor(
  tailoringJob: TailoringJob | null,
  job: JobDescription | null
): TailoringJob | null {
  if (!tailoringJob) return null;
  if (!job) return tailoringJob;
  return tailoringJob.jobKey === tailoringJobKey(job) ? tailoringJob : null;
}

export type PopupView =
  | "signed-out"
  | "linkedin-loading"
  | "linkedin-unsupported"
  | "new-user"
  | "no-job"
  | "build-cv"
  | "job";

// Decides which popup screen to render. Precedence matters: a brand-new user
// with no base CV and no job must see the "create your CV" welcome rather than
// the "send a selection" demo, which assumes they already have a CV.
export function selectPopupView(
  state: StorageState,
  job: JobDescription | null,
  linkedinScan: LinkedInScanResult | null
): PopupView {
  if (!state.auth) return "signed-out";
  if (!job && linkedinScan?.status === "loading") return "linkedin-loading";
  if (!job && linkedinScan?.status === "unsupported") return "linkedin-unsupported";

  const noBaseCv = !state.settings.onboardingComplete || !state.profile;
  if (noBaseCv && !job) return "new-user";
  if (!job) return "no-job";
  if (noBaseCv) return "build-cv";
  return "job";
}
