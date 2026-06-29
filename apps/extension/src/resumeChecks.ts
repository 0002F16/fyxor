import { bulletHasMetric, educationHasContent, flattenSkillCategories, normalizeSkillCategories, type BaseProfile, type ResumeDocument } from "@cv-tailor/shared";

// Heuristic resume-completeness engine. Pure and side-effect free so it can be
// unit-tested and reused by the base-resume and tailored-CV editors alike. It
// inspects a ResumeDocument (both BaseProfile and TailoredCv satisfy it) and
// reports which quality checks pass, plus a weighted 0–100 score.

export type CheckSeverity = "required" | "recommended";

export interface ResumeCheck {
  id: string;
  label: string;
  // How to fix it — surfaced as a tooltip in the UI.
  detail: string;
  severity: CheckSeverity;
  passed: boolean;
}

export interface ResumeStrength {
  // Only the still-relevant, non-dismissed checks, so the UI can render the
  // outstanding suggestions directly.
  checks: ResumeCheck[];
  score: number; // 0–100
}

// Required checks weigh more than recommended ones so missing essentials (name,
// email, any experience) pull the score down harder than nice-to-haves.
const WEIGHT: Record<CheckSeverity, number> = { required: 2, recommended: 1 };

const MIN_SUMMARY_CHARS = 80;
const MIN_BULLETS_PER_ROLE = 2;
const MIN_SKILLS = 5;

// Onboarding-level completeness, grouped by the sections the setup wizard walks.
// Drives the "smart stepper": a parsed profile auto-skips sections that come back
// `complete`, and the manual path uses the same booleans for its progress meter.
// Pure so it can be unit-tested and shared between the summary cards and steps.
export type ProfileSectionId = "basics" | "experience" | "skills" | "education" | "extras";

export interface SectionStatus {
  id: ProfileSectionId;
  label: string;
  complete: boolean;
  // One-line recap when complete (e.g. "3 roles · 11 bullets"), shown on the
  // collapsed summary card.
  summary: string;
  // What's missing when incomplete — surfaced on the expanded card so the user
  // knows exactly why it needs a look.
  reason?: string;
}

export function sectionCompleteness(profile: BaseProfile): SectionStatus[] {
  const categories = normalizeSkillCategories(profile.skillCategories, profile.skills);
  const skillCount = flattenSkillCategories(categories).filter(Boolean).length;
  const rolesWithContent = profile.experiences.filter((e) => e.role.trim() || e.company.trim() || e.bullets.some(Boolean));
  const bulletCount = rolesWithContent.reduce((n, e) => n + e.bullets.filter((b) => b.trim()).length, 0);
  const thinRoles = rolesWithContent.filter((e) => e.bullets.filter((b) => b.trim()).length < MIN_BULLETS_PER_ROLE);
  const eduWithContent = profile.education.filter(educationHasContent);
  const certCount = profile.certifications.filter((c) => c.trim()).length;
  const langCount = profile.languages.filter((l) => l.language.trim()).length;
  const someBullets = rolesWithContent.some((e) => e.bullets.some((b) => b.trim()));
  const anyMetric = rolesWithContent.some((e) => e.bullets.some(bulletHasMetric));

  const basicsComplete = Boolean(profile.contact.name.trim() && profile.contact.email.trim());
  const experienceComplete = rolesWithContent.length > 0 && thinRoles.length === 0;
  const skillsComplete = skillCount >= MIN_SKILLS;
  const educationComplete = eduWithContent.length > 0;

  return [
    {
      id: "basics", label: "Basics", complete: basicsComplete,
      summary: profile.contact.name.trim() ? `${profile.contact.name.trim()}${profile.contact.email.trim() ? ` · ${profile.contact.email.trim()}` : ""}` : "Name and contact details",
      reason: basicsComplete ? undefined : "Add your name and a contact email."
    },
    {
      id: "experience", label: "Experience", complete: experienceComplete,
      summary: rolesWithContent.length ? `${rolesWithContent.length} role${rolesWithContent.length === 1 ? "" : "s"} · ${bulletCount} bullet${bulletCount === 1 ? "" : "s"}` : "Your work history",
      reason: rolesWithContent.length === 0
        ? "Add at least one role with a few bullet points."
        : thinRoles.length > 0
          ? `Add at least ${MIN_BULLETS_PER_ROLE} bullets to every role.`
          : someBullets && !anyMetric
            ? "Looks good — adding a number to a bullet would make it even stronger."
            : undefined
    },
    {
      id: "skills", label: "Skills", complete: skillsComplete,
      summary: skillCount ? `${skillCount} skill${skillCount === 1 ? "" : "s"}` : "Your key skills",
      reason: skillsComplete ? undefined : `List at least ${MIN_SKILLS} relevant skills.`
    },
    {
      id: "education", label: "Education", complete: educationComplete,
      summary: eduWithContent.length ? `${eduWithContent.length} entr${eduWithContent.length === 1 ? "y" : "ies"}` : "Your degree or qualifications",
      reason: educationComplete ? undefined : "Add your degree or qualifications."
    },
    {
      // Optional by design — never blocks finishing, so always "complete".
      id: "extras", label: "Certifications & languages", complete: true,
      summary: certCount || langCount
        ? [certCount && `${certCount} cert${certCount === 1 ? "" : "s"}`, langCount && `${langCount} language${langCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
        : "Optional — add if they help"
    }
  ];
}

// A "documented" resume can be either a base profile (headline via targetRole)
// or a tailored CV (headline via job.title, plus unsupportedClaims). We read
// those extra fields loosely so the one engine serves both.
type Evaluatable = ResumeDocument & {
  targetRole?: string;
  unsupportedClaims?: Array<unknown>;
  dismissedChecks?: string[];
};

export function evaluateResume(
  doc: Evaluatable,
  kind: "base" | "tailored",
  dismissed: string[] = []
): ResumeStrength {
  const categories = normalizeSkillCategories(doc.skillCategories, doc.skills);
  const nonEmptyCategories = categories.filter(([, entries]) => entries.filter(Boolean).length > 0);
  const skillCount = flattenSkillCategories(categories).filter(Boolean).length;
  const rolesWithContent = doc.experiences.filter((e) => e.role.trim() || e.bullets.some(Boolean));
  const headline = kind === "tailored" ? (doc.job?.title ?? "") : (doc.targetRole ?? "");

  const all: ResumeCheck[] = [
    {
      id: "contact-name", severity: "required", passed: Boolean(doc.contact.name.trim()),
      label: "Add your name", detail: "Every resume needs your full name at the top."
    },
    {
      id: "contact-email", severity: "required", passed: Boolean(doc.contact.email.trim()),
      label: "Add an email", detail: "Recruiters need a way to reach you — add a contact email."
    },
    {
      id: "contact-phone", severity: "recommended", passed: Boolean(doc.contact.phone.trim()),
      label: "Add a phone number", detail: "A phone number gives recruiters a faster way to contact you."
    },
    {
      id: "contact-location", severity: "recommended", passed: Boolean(doc.contact.location.trim()),
      label: "Add your location", detail: "A city/country helps recruiters gauge fit and time zone."
    },
    {
      id: "contact-linkedin", severity: "recommended", passed: Boolean(doc.contact.linkedIn.trim()),
      label: "Add your LinkedIn", detail: "A LinkedIn link lets recruiters see your full profile."
    },
    {
      id: "headline", severity: "recommended", passed: Boolean(headline.trim()),
      label: "Add a title under your name", detail: "A target role beneath your name frames the whole resume."
    },
    {
      id: "summary", severity: "recommended", passed: doc.summary.trim().length >= MIN_SUMMARY_CHARS,
      label: "Write a fuller summary", detail: `A short professional summary (at least ${MIN_SUMMARY_CHARS} characters) gives recruiters context fast.`
    },
    {
      id: "experience-exists", severity: "required", passed: rolesWithContent.length > 0,
      label: "Add work experience", detail: "Add at least one role with a title so your experience shows."
    },
    {
      id: "experience-bullets", severity: "recommended",
      passed: rolesWithContent.every((e) => e.bullets.filter(Boolean).length >= MIN_BULLETS_PER_ROLE),
      label: "Add more bullet points", detail: `Each role reads stronger with at least ${MIN_BULLETS_PER_ROLE} achievement bullets.`
    },
    {
      id: "skills-groups", severity: "recommended", passed: nonEmptyCategories.length > 1,
      label: "Group skills into more categories", detail: "One skills bucket looks thin — split skills into themed groups (e.g. Languages, Tools, Frameworks)."
    },
    {
      id: "skills-count", severity: "recommended", passed: skillCount >= MIN_SKILLS,
      label: "List more skills", detail: `Aim for at least ${MIN_SKILLS} relevant skills so the section reads complete.`
    },
    {
      id: "education", severity: "recommended", passed: doc.education.some(educationHasContent),
      label: "Add education", detail: "Add your degree or qualifications so the resume isn't missing a section recruiters expect."
    }
  ];

  if (kind === "tailored") {
    all.push({
      id: "unsupported-claims", severity: "recommended",
      passed: (doc.unsupportedClaims?.length ?? 0) === 0,
      label: "Review possible unsupported claims",
      detail: "The tailoring flagged claims that may not be backed by your base resume — review or remove them."
    });
  }

  // Dismissed checks ("forcefully ignore") drop out of both the displayed list
  // and the score, so ignoring stops the nagging and stops the penalty.
  const ignore = new Set(dismissed);
  const relevant = all.filter((check) => !ignore.has(check.id));

  const totalWeight = relevant.reduce((sum, c) => sum + WEIGHT[c.severity], 0);
  const passedWeight = relevant.reduce((sum, c) => sum + (c.passed ? WEIGHT[c.severity] : 0), 0);
  const score = totalWeight === 0 ? 100 : Math.round((passedWeight / totalWeight) * 100);

  return { checks: relevant.filter((c) => !c.passed), score };
}
