import { z } from "zod";

export const aiProviderSchema = z.enum(["codex-local", "openai-api", "gemini-api", "groq-api"]);
export const tailoringEngineSchema = z.enum(["builtin", "ccc"]);
export const evidenceStatusSchema = z.enum(["verified", "needs-review", "stale", "unsupported", "legacy-unverified"]);
export const skillProvenanceSchema = z.enum(["explicit", "equivalent", "inferred-baseline"]);
export const requirementCoverageSchema = z.enum(["explicit", "supported-equivalent", "inferred-baseline", "unsupported"]);
export const readinessStatusSchema = z.enum(["ready", "needs-source-update", "blocked"]);
export const evalDimensionSchema = z.enum(["truthfulness", "relevance", "readability", "ats", "appropriateness"]);
export const evalStatusSchema = z.enum(["pass", "warn", "fail"]);

export const contactSchema = z.object({
  name: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  linkedIn: z.string().default("")
});

export const languageSchema = z.object({
  language: z.string().default(""),
  level: z.string().default("")
});

export const positioningSchema = z.object({
  level: z.string().default(""),
  strategy: z.string().default(""),
  notes: z.string().default("")
});

export const projectSchema = z.object({
  id: z.string(),
  title: z.string().default(""),
  description: z.string().default(""),
  bullets: z.array(z.string()).default([]),
  technologies: z.array(z.string()).default([])
});

export const experienceSchema = z.object({
  id: z.string(),
  company: z.string(),
  role: z.string(),
  startDate: z.string().default(""),
  endDate: z.string().default(""),
  bullets: z.array(z.string()).default([])
});

// Structured education entry, mirroring what a Harvard-format resume captures.
// Every field is optional except, in practice, the school — empty entries are
// filtered out by `educationHasContent`.
export const educationEntrySchema = z.object({
  id: z.string(),
  school: z.string().default(""),
  degree: z.string().default(""), // degree & concentration
  location: z.string().default(""),
  graduationDate: z.string().default(""),
  gpa: z.string().default(""),
  honors: z.string().default(""),
  coursework: z.array(z.string()).default([])
});

// Coerces legacy data into structured entries: a plain string (the old flat
// education line) becomes an entry with the text kept in `school`, and any
// object missing an `id` is assigned one. Used everywhere the profile/CV schema
// parses, so migration is automatic for stored state, cloud pulls, and AI output.
function coerceEducation(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((entry) => {
    if (typeof entry === "string") return { id: makeId("edu"), school: entry };
    if (entry && typeof entry === "object" && !("id" in entry)) return { id: makeId("edu"), ...entry };
    return entry;
  });
}

const educationArraySchema = z.preprocess(coerceEducation, z.array(educationEntrySchema)).default([]);

// Per-CV visual style — one of three curated presets. "modern" is the emerald
// sans look; the two serif presets are intentionally monochrome (classic, ATS-
// friendly). Resolved into CSS variables by `resumeStyleVars` (live canvas +
// PDF) and into DOCX values by the export. Kept as an object (not a bare enum)
// so future per-resume style knobs can be added without another migration.
export const cvStyleSchema = z.object({
  preset: z.enum(["modern", "garamond", "times"]).default("modern")
});

export const baseProfileSchema = z.object({
  id: z.string(),
  contact: contactSchema,
  targetRole: z.string().default(""),
  summary: z.string().default(""),
  experiences: z.array(experienceSchema).default([]),
  education: educationArraySchema,
  projects: z.array(projectSchema).optional(),
  skills: z.array(z.string()).default([]),
  skillCategories: z.record(z.array(z.string())).default({}),
  certifications: z.array(z.string()).default([]),
  languages: z.array(languageSchema).default([]),
  positioning: positioningSchema.optional(),
  sectionOrder: z.array(z.string()).default([]),
  style: cvStyleSchema.default({}),
  dismissedChecks: z.array(z.string()).default([]),
  rawText: z.string().default(""),
  updatedAt: z.string()
});

export const jobDescriptionSchema = z.object({
  title: z.string().default(""),
  company: z.string().default(""),
  location: z.string().default(""),
  description: z.string().min(20, "Job description is too short"),
  url: z.string().default(""),
  source: z.enum(["linkedin", "manual"]).default("manual")
});

export const tailoredExperienceSchema = experienceSchema.extend({
  sourceExperienceId: z.string().default(""),
  originalRole: z.string().default(""),
  titleEvidenceStatus: z.enum(["unchanged", "verified-reframe", "needs-review"]).default("unchanged"),
  bullets: z.preprocess((input) => {
    if (!Array.isArray(input)) return input;
    return input.map((bullet, index) => typeof bullet === "string"
      ? { id: `legacy_bullet_${index}`, text: bullet, sourceBulletIndexes: [], evidenceStatus: "legacy-unverified" }
      : bullet);
  }, z.array(z.object({
    id: z.string(),
    text: z.string(),
    sourceBulletIndexes: z.array(z.number().int().nonnegative()).default([]),
    evidenceStatus: evidenceStatusSchema.default("legacy-unverified")
  }))).default([]),
  // Compatibility projection for old clients. New code uses per-bullet citations.
  sourceBulletIndexes: z.array(z.number().int().nonnegative()).default([])
});

export const unsupportedClaimSchema = z.object({
  section: z.string(),
  text: z.string(),
  reason: z.string()
});

export const evidenceReferenceSchema = z.object({
  sourceExperienceId: z.string(),
  sourceBulletIndexes: z.array(z.number().int().nonnegative()).default([])
});

// LLM evidence-plan output occasionally returns an evidence array as a single
// object. Coerce a lone object into a one-element array so one stray shape never
// hard-fails an otherwise-valid tailoring run.
const coerceToArray = (val: unknown): unknown =>
  Array.isArray(val) ? val : val && typeof val === "object" ? [val] : [];
const evidenceArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(coerceToArray, z.array(item));

// Summary evidence can come from the complete profile, not only experience
// bullets. A single object shape keeps strict provider JSON schemas portable;
// fields not used by the selected `kind` remain empty.
export const summaryEvidenceReferenceSchema = z.object({
  kind: z.enum([
    "experience",
    "language",
    "skill",
    "certification",
    "education",
    "employment",
    "project",
    "authorization",
    "inference"
  ]).optional(),
  sourceExperienceId: z.string().optional(),
  sourceBulletIndexes: z.array(z.number().int().nonnegative()).optional(),
  language: z.string().optional(),
  level: z.string().optional(),
  skill: z.string().optional(),
  certification: z.string().optional(),
  educationId: z.string().optional(),
  projectId: z.string().optional(),
  value: z.string().optional(),
  basis: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional()
});

export const summaryClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  evidence: z.array(summaryEvidenceReferenceSchema).default([]),
  requirementIds: z.array(z.string()).optional(),
  provenance: z.enum(["explicit", "equivalent", "inferred-context"]).optional(),
  evidenceStatus: evidenceStatusSchema.default("verified")
});

export const skillEvidenceSchema = z.object({
  skill: z.string(),
  evidence: z.array(evidenceReferenceSchema).default([]),
  evidenceStatus: evidenceStatusSchema.default("verified"),
  provenance: skillProvenanceSchema.default("explicit"),
  sourceSkills: z.array(z.string()).default([]),
  requirementIds: z.array(z.string()).default([])
});

export const evidencePlanSchema = z.object({
  version: z.string().default("1"),
  fit: z.enum(["direct", "adjacent", "stretch"]),
  fitDimensions: z.object({
    functionFit: z.enum(["direct", "adjacent", "change"]),
    industryFit: z.enum(["direct", "adjacent", "unknown"]),
    seniorityFit: z.enum(["matched", "step-up", "step-down", "unknown"]),
    evidenceStrength: z.enum(["strong", "partial", "weak"])
  }).optional(),
  requirements: z.array(z.object({
    id: z.string(),
    text: z.string(),
    priority: z.enum(["must", "important", "supporting"]),
    type: z.enum([
      "function",
      "industry",
      "seniority",
      "language",
      "certification",
      "license",
      "tool",
      "education",
      "authorization",
      "competency",
      "other"
    ]).optional(),
    hiringImportance: z.number().int().min(1).max(5).optional(),
    summaryValue: z.number().int().min(1).max(5).optional(),
    coverage: requirementCoverageSchema.default("unsupported"),
    evidence: evidenceArray(evidenceReferenceSchema).default([]),
    summaryEvidence: evidenceArray(summaryEvidenceReferenceSchema).optional(),
    sourceSkills: z.array(z.string()).default([])
  })),
  summaryClaims: z.array(z.object({
    id: z.string(),
    objective: z.string(),
    evidence: evidenceArray(summaryEvidenceReferenceSchema),
    requirementIds: z.array(z.string()).optional(),
    mandatory: z.boolean().optional(),
    provenance: z.enum(["explicit", "equivalent", "inferred-context"]).optional()
  })),
  summaryBlueprint: z.object({
    positioningMode: z.enum([
      "target-identity",
      "adjacent-identity",
      "transition",
      "transferable",
      "education-led",
      "executive"
    ]).optional(),
    positioningStrategy: z.string().optional(),
    targetIdentityAllowed: z.boolean().optional(),
    decisiveRequirementIds: z.array(z.string()).optional(),
    claimIds: z.array(z.string()).optional()
  }).optional(),
  roles: z.array(z.object({
    sourceExperienceId: z.string(),
    include: z.boolean(),
    originalTitle: z.string(),
    proposedTitle: z.string(),
    titleEvidence: evidenceArray(evidenceReferenceSchema).default([]),
    titleConfidence: z.enum(["high", "medium", "low"]),
    bulletObjectives: z.array(z.object({
      id: z.string(),
      objective: z.string(),
      sourceBulletIndexes: z.array(z.number().int().nonnegative()),
      requirementIds: z.array(z.string()).default([])
    }))
  })),
  skills: z.array(z.object({
    skill: z.string(),
    category: z.string(),
    requirementIds: z.array(z.string()).default([]),
    evidence: evidenceArray(evidenceReferenceSchema).default([]),
    provenance: skillProvenanceSchema.default("explicit"),
    sourceSkills: z.array(z.string()).default([])
  })),
  certifications: z.array(z.string()).default([]),
  sectionOrder: z.array(z.string()).default([]),
  pageTarget: z.enum(["one", "two"])
});

export const evaluationFindingSchema = z.object({
  id: z.string(),
  dimension: evalDimensionSchema,
  status: evalStatusSchema,
  label: z.string(),
  detail: z.string(),
  section: z.string().default(""),
  sourceExperienceId: z.string().default("")
});

export const resumeEvaluationSchema = z.object({
  evaluatorVersion: z.string().default("1"),
  checks: z.array(evaluationFindingSchema).default([]),
  scores: z.record(z.number()).default({}),
  hardFailureIds: z.array(z.string()).default([])
});

export const pipelineMetadataSchema = z.object({
  pipelineVersion: z.string().default("unified-v4"),
  runId: z.string().default(""),
  provider: z.string().default(""),
  model: z.string().default(""),
  legacyEngine: tailoringEngineSchema.optional(),
  stages: z.array(z.object({
    name: z.string(),
    durationMs: z.number().nonnegative(),
    attempts: z.number().int().positive().default(1),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional()
  })).default([]),
  aiCallCount: z.number().int().nonnegative().default(0),
  repairCount: z.number().int().nonnegative().default(0),
  recoveries: z.array(z.object({
    code: z.string(),
    section: z.string().default(""),
    sourceExperienceId: z.string().default(""),
    severity: z.enum(["corrected", "dropped", "degraded"]).default("corrected")
  })).optional()
});

export const tailoredCvSchema = z.object({
  id: z.string(),
  baseProfileId: z.string(),
  job: jobDescriptionSchema,
  contact: contactSchema,
  summary: z.string(),
  summaryClaims: z.array(summaryClaimSchema).default([]),
  experiences: z.array(tailoredExperienceSchema),
  education: educationArraySchema,
  skills: z.array(z.string()),
  skillEvidence: z.array(skillEvidenceSchema).default([]),
  skillCategories: z.record(z.array(z.string())).default({}),
  certifications: z.array(z.string()).default([]),
  languages: z.array(languageSchema).default([]),
  sectionOrder: z.array(z.string()).default([]),
  style: cvStyleSchema.default({}),
  dismissedChecks: z.array(z.string()).default([]),
  unsupportedClaims: z.array(unsupportedClaimSchema).default([]),
  evidencePlan: evidencePlanSchema.optional(),
  evaluation: resumeEvaluationSchema.optional(),
  pipeline: pipelineMetadataSchema.default({}),
  readiness: readinessStatusSchema.default("needs-source-update"),
  createdAt: z.string(),
  updatedAt: z.string()
});

// Lifecycle of a tailored application, set manually by the user from the home
// table. Defaults to "not-sent" so existing stored records migrate cleanly.
export const applicationStatusSchema = z.enum(["not-sent", "sent", "replied"]);

export const applicationRecordSchema = z.object({
  id: z.string(),
  job: jobDescriptionSchema,
  tailoredCv: tailoredCvSchema,
  status: applicationStatusSchema.default("not-sent"),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const regenerationRequestSchema = z.object({
  profile: baseProfileSchema,
  cv: tailoredCvSchema,
  section: z.enum(["summary", "experience", "skills"]),
  experienceId: z.string().optional()
});

export const regenerationPatchSchema = z.discriminatedUnion("section", [
  z.object({
    section: z.literal("summary"),
    summary: z.string(),
    summaryClaims: z.array(summaryClaimSchema),
    evaluation: resumeEvaluationSchema,
    readiness: readinessStatusSchema
  }),
  z.object({
    section: z.literal("experience"),
    experienceId: z.string(),
    experience: tailoredExperienceSchema,
    evaluation: resumeEvaluationSchema,
    readiness: readinessStatusSchema
  }),
  z.object({
    section: z.literal("skills"),
    skills: z.array(z.string()),
    skillCategories: z.record(z.array(z.string())),
    skillEvidence: z.array(skillEvidenceSchema),
    evaluation: resumeEvaluationSchema,
    readiness: readinessStatusSchema
  })
]);

export const authSessionSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().default(""),
  token: z.string(),
  expiresAt: z.string().default("")
});

// The per-user data we replicate to the server. Settings stay device-local
// (apiBaseUrl, provider, engine), so they are deliberately excluded here.
export const syncPayloadSchema = z.object({
  profile: baseProfileSchema.nullable().default(null),
  drafts: z.record(tailoredCvSchema).default({}),
  applications: z.array(applicationRecordSchema).default([])
});

export const tailoringJobSchema = z.object({
  status: z.enum(["running", "done", "error"]),
  error: z.string().default(""),
  cvId: z.string().default(""),
  runId: z.string().default(""),
  stage: z.string().default(""),
  progress: z.number().min(0).max(100).default(0),
  // Stable identifier of the job this run belongs to (see `tailoringJobKey`), so
  // the popup can tell whether a stored running/done/error slot actually refers
  // to the job currently on screen — preventing a finished job from hijacking
  // the UI for a different, freshly selected job.
  jobKey: z.string().default(""),
  // Epoch ms when a "running" job started, so the popup can detect a run
  // orphaned by a terminated service worker and surface it as an error.
  startedAt: z.number().default(0)
});

export const tailoringRunStatusSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  stage: z.enum(["queued", "planning", "writing", "validating", "critic", "repairing", "completed"]),
  progress: z.number().min(0).max(100),
  error: z.string().default(""),
  cv: tailoredCvSchema.optional(),
  evaluation: resumeEvaluationSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const storageStateSchema = z.object({
  version: z.literal(2),
  profile: baseProfileSchema.nullable(),
  drafts: z.record(tailoredCvSchema),
  applications: z.array(applicationRecordSchema),
  resumeVariants: z.array(tailoredCvSchema).default([]),
  pendingJob: jobDescriptionSchema.nullable().default(null),
  tailoringJob: tailoringJobSchema.nullable().default(null),
  auth: authSessionSchema.nullable().default(null),
  settings: z.object({
    apiBaseUrl: z.string().default("https://api-76-13-177-250.sslip.io"),
    aiProvider: aiProviderSchema.default("groq-api"),
    providerDefaultMigrated: z.boolean().default(false),
    tailoringEngine: tailoringEngineSchema.default("builtin"),
    onboardingComplete: z.boolean().default(false),
    // The onboarding view the user last reached (e.g. "summary", "experience").
    // Non-empty while a setup is in progress so the router can resume it after a
    // refresh; cleared back to "" when onboarding finishes.
    onboardingStep: z.string().default(""),
    welcomeSeen: z.boolean().default(false),
    pinScreenSeen: z.boolean().default(false),
    inlineEditHintSeen: z.boolean().default(false),
    resumeStrengthHidden: z.boolean().default(false),
    // Which Applications layout the user last chose. Device-local, not synced.
    trackerView: z.enum(["list", "board"]).default("list")
  })
});

export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type Project = z.infer<typeof projectSchema>;
export type BaseProfile = z.infer<typeof baseProfileSchema>;
export type JobDescription = z.infer<typeof jobDescriptionSchema>;
export type TailoredCv = z.infer<typeof tailoredCvSchema>;
export type TailoredExperience = z.infer<typeof tailoredExperienceSchema>;
export type TailoredBullet = TailoredExperience["bullets"][number];
export type EvidencePlan = z.infer<typeof evidencePlanSchema>;
export type SummaryEvidenceReference = z.infer<typeof summaryEvidenceReferenceSchema>;
export type SkillProvenance = z.infer<typeof skillProvenanceSchema>;
export type ResumeEvaluation = z.infer<typeof resumeEvaluationSchema>;
export type EvaluationFinding = z.infer<typeof evaluationFindingSchema>;
export type RegenerationPatch = z.infer<typeof regenerationPatchSchema>;
export type TailoringRunStatus = z.infer<typeof tailoringRunStatusSchema>;
export type ApplicationRecord = z.infer<typeof applicationRecordSchema>;
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;
export type RegenerationRequest = z.infer<typeof regenerationRequestSchema>;
export type StorageState = z.infer<typeof storageStateSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type TailoringJob = z.infer<typeof tailoringJobSchema>;
export type SyncPayload = z.infer<typeof syncPayloadSchema>;
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type TailoringEngine = z.infer<typeof tailoringEngineSchema>;
export type Language = z.infer<typeof languageSchema>;
export type Positioning = z.infer<typeof positioningSchema>;
export type CvStyle = z.infer<typeof cvStyleSchema>;

export const emptyStorageState = (): StorageState => ({
  version: 2,
  profile: null,
  drafts: {},
  applications: [],
  resumeVariants: [],
  pendingJob: null,
  tailoringJob: null,
  auth: null,
  settings: {
    apiBaseUrl: "http://127.0.0.1:8787",
    aiProvider: "groq-api",
    providerDefaultMigrated: true,
    tailoringEngine: "builtin",
    onboardingComplete: false,
    onboardingStep: "",
    welcomeSeen: false,
    pinScreenSeen: false,
    inlineEditHintSeen: false,
    resumeStrengthHidden: false,
    trackerView: "list"
  }
});

const VPS_API_URL = "https://api-76-13-177-250.sslip.io";
const LOCAL_URL = "http://127.0.0.1:8787";

export function migrateStorage(input: unknown): StorageState {
  const candidate = input && typeof input === "object"
    ? { ...(input as Record<string, unknown>), version: 2 }
    : input;
  const parsed = storageStateSchema.safeParse(candidate);
  const state = parsed.success ? parsed.data : emptyStorageState();
  // Apply the new Groq default once to existing installs. The marker preserves
  // later explicit provider choices made in Advanced settings.
  if (!state.settings.providerDefaultMigrated) {
    if (state.settings.aiProvider === "codex-local" || state.settings.aiProvider === "gemini-api") {
      state.settings.aiProvider = "groq-api";
    }
    state.settings.providerDefaultMigrated = true;
  }
  return state;
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function bulletText(bullet: string | TailoredBullet): string {
  return typeof bullet === "string" ? bullet : bullet.text;
}

export function legacyBulletTexts(bullets: Array<string | TailoredBullet>): string[] {
  return bullets.map(bulletText);
}

export function markTailoredTextStale(cv: TailoredCv, section: "summary" | "experience" | "skills", experienceId?: string): TailoredCv {
  if (section === "summary") {
    return {
      ...cv,
      summaryClaims: cv.summaryClaims.map((claim) => ({ ...claim, evidenceStatus: "stale" })),
      readiness: "blocked"
    };
  }
  if (section === "skills") {
    return {
      ...cv,
      skillEvidence: cv.skillEvidence.map((skill) => ({ ...skill, evidenceStatus: "stale" })),
      readiness: "blocked"
    };
  }
  return {
    ...cv,
    experiences: cv.experiences.map((experience) => experience.id === experienceId
      ? {
        ...experience,
        titleEvidenceStatus: "needs-review",
        bullets: experience.bullets.map((bullet, index) => typeof bullet === "string"
          ? { id: `edited_bullet_${index}`, text: bullet, sourceBulletIndexes: [], evidenceStatus: "stale" as const }
          : { ...bullet, evidenceStatus: "stale" as const })
      }
      : experience),
    readiness: "blocked"
  };
}

// Stable key identifying a job across the popup and background worker, so a
// stored `tailoringJob` can be matched to the job currently on screen. Prefers
// the URL (unique per posting); falls back to title+company for selection-based
// jobs that may lack a URL. Returns "" when there's no job to key.
export function tailoringJobKey(job: { url?: string; title?: string; company?: string } | null | undefined): string {
  if (!job) return "";
  const url = (job.url || "").trim();
  if (url) return url;
  return `${(job.title || "").trim()}@@${(job.company || "").trim()}`;
}

// Skills are stored two ways: `skillCategories` ({ theme: entries[] }) for themed
// display, plus a flat `skills` union the export/stats read. These helpers are the
// single source of truth for converting between the two, shared by the resume
// canvas, the onboarding editor, and the PDF/DOCX export.

// Returns ordered [category, entries] pairs. Prefers themed categories; falls back
// to wrapping the flat list in one "Skills" group. With includeEmpty, always yields
// at least that group so an editor can render an empty starting row.
export function normalizeSkillCategories(
  skillCategories: Record<string, string[]>,
  skills: string[],
  includeEmpty = false
): Array<[string, string[]]> {
  if (Object.keys(skillCategories).length) return Object.entries(skillCategories);
  if (skills.length || includeEmpty) return [["Skills", skills]];
  return [];
}

// Flat de-duplicated union of every category's entries, matching the order seen.
export function flattenSkillCategories(cats: Array<[string, string[]]>): string[] {
  return Array.from(new Set(cats.flatMap(([, entries]) => entries)));
}

// True when a résumé bullet already carries a quantified outcome — a digit
// (covers percentages, counts, money amounts, years, and multipliers like "3x").
// Used to nudge the user, during onboarding, to add metrics to bullets that have
// none. Intentionally simple and predictable: any digit counts as evidence.
export function bulletHasMetric(text: string): boolean {
  return /\d/.test(text);
}

export function missingStructuredProfileEvidence(profile: BaseProfile): Array<"certifications" | "languages"> {
  const raw = profile.rawText || "";
  const gaps: Array<"certifications" | "languages"> = [];
  if (!profile.certifications.length && /\b(certifications?|acca|cpa|chartered accountant|udemy|linkedin learning)\b/i.test(raw)) {
    gaps.push("certifications");
  }
  if (!profile.languages.length && /\b(languages?|native|fluent|proficient|bilingual|[abc][12])\b/i.test(raw)) {
    gaps.push("languages");
  }
  return gaps;
}

// True when an education entry has any real content — used to filter out empty
// editing rows from the rendered resume, the export, and completeness checks.
export function educationHasContent(entry: EducationEntry): boolean {
  return Boolean(
    entry.school || entry.degree || entry.location || entry.graduationDate ||
    entry.gpa || entry.honors || entry.coursework.some(Boolean)
  );
}

// Resolves a structured education entry into the lines a Harvard-format resume
// shows. Single source of truth for the non-editable canvas render and the
// PDF/DOCX export so they stay WYSIWYG.
export function formatEducationEntry(entry: EducationEntry): { title: string; subtitle: string; meta: string; bullets: string[] } {
  const gpa = entry.gpa.trim() ? `GPA ${entry.gpa.trim()}` : "";
  return {
    title: [entry.school, entry.location].map((s) => s.trim()).filter(Boolean).join(", "),
    subtitle: [[entry.degree, entry.honors].map((s) => s.trim()).filter(Boolean).join(", "), gpa].filter(Boolean).join(" · "),
    meta: entry.graduationDate.trim(),
    bullets: entry.coursework.filter(Boolean)
  };
}

// Merges a regenerated CV back into the current one, touching ONLY the section
// the user asked to regenerate. Regeneration returns a whole TailoredCv built
// from a pre-edit snapshot, so replacing the document wholesale would silently
// discard any inline edits the user made to other sections while the request was
// in flight. By carrying everything except the targeted section over from
// `current`, those concurrent edits — and user state like unsupportedClaims,
// sectionOrder, and dismissedChecks — always survive.
export function applyRegeneratedSection(
  current: TailoredCv,
  regenerated: TailoredCv | RegenerationPatch,
  section: "summary" | "experience" | "skills",
  experienceId?: string
): TailoredCv {
  if ("section" in regenerated) {
    if (regenerated.section === "summary") {
      return { ...current, summary: regenerated.summary, summaryClaims: regenerated.summaryClaims, evaluation: regenerated.evaluation, readiness: regenerated.readiness };
    }
    if (regenerated.section === "skills") {
      return { ...current, skills: regenerated.skills, skillCategories: regenerated.skillCategories, skillEvidence: regenerated.skillEvidence, evaluation: regenerated.evaluation, readiness: regenerated.readiness };
    }
    return {
      ...current,
      experiences: current.experiences.map((experience) => experience.id === regenerated.experienceId ? regenerated.experience : experience),
      evaluation: regenerated.evaluation,
      readiness: regenerated.readiness
    };
  }
  if (section === "summary") {
    return { ...current, summary: regenerated.summary };
  }
  if (section === "skills") {
    return { ...current, skills: regenerated.skills, skillCategories: regenerated.skillCategories };
  }
  // section === "experience": replace just the regenerated role, matched by id.
  const replacement = regenerated.experiences.find((e) => e.id === experienceId);
  if (!replacement) return current; // defensive: nothing matched, leave as-is
  return {
    ...current,
    experiences: current.experiences.map((e) => (e.id === experienceId ? replacement : e))
  };
}

// Canonical section ids and their default top-to-bottom order on the resume.
// `sectionOrder` on a profile/CV stores a user-chosen permutation of these; an
// empty array means "use the default". Both the canvas and the PDF/DOCX export
// resolve the effective order through `effectiveSectionOrder` so they stay in sync.
export const SECTION_IDS = ["summary", "experience", "skills", "certifications", "languages", "education"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export const DEFAULT_SECTION_ORDER: SectionId[] = [...SECTION_IDS];

// Resolve a stored order into a complete, valid sequence: drop unknown ids and
// append any canonical sections the stored order is missing, so a newly added
// section never silently disappears for users with an older saved order.
export function effectiveSectionOrder(order: string[] = []): SectionId[] {
  const known = order.filter((id): id is SectionId => (SECTION_IDS as readonly string[]).includes(id));
  const seen = new Set(known);
  return [...known, ...DEFAULT_SECTION_ORDER.filter((id) => !seen.has(id))];
}

// Build a minimal JobDescription from a bare target-role string so the tailoring
// pipeline has something to optimise against when there's no full job posting.
export function synthesizeRoleJob(role: string): JobDescription {
  return jobDescriptionSchema.parse({
    title: role,
    company: "",
    location: "",
    description: `Target role: ${role}`,
    url: "",
    source: "manual"
  });
}

// Convert a BaseProfile into a minimal TailoredCv so the export endpoint (which
// only accepts TailoredCv) can render the untailored base resume as a PDF/DOCX.
// Uses schema defaults for all pipeline/evidence fields; pageTarget is absent
// so the server allows up to 2 pages.
export function baseProfileToExportCv(profile: BaseProfile): TailoredCv {
  const now = profile.updatedAt;
  return tailoredCvSchema.parse({
    id: makeId("cv"),
    baseProfileId: profile.id,
    job: synthesizeRoleJob(profile.targetRole || "Resume"),
    contact: profile.contact,
    summary: profile.summary,
    summaryClaims: [],
    experiences: profile.experiences.map((exp) => ({
      ...exp,
      sourceExperienceId: exp.id,
      originalRole: exp.role,
      titleEvidenceStatus: "unchanged",
      bullets: exp.bullets.map((text, i) => ({
        id: `base_bullet_${i}`,
        text: String(text),
        sourceBulletIndexes: [],
        evidenceStatus: "legacy-unverified"
      }))
    })),
    education: profile.education,
    skills: profile.skills,
    skillEvidence: [],
    skillCategories: profile.skillCategories,
    certifications: profile.certifications,
    languages: profile.languages,
    sectionOrder: profile.sectionOrder,
    style: profile.style,
    dismissedChecks: profile.dismissedChecks ?? [],
    unsupportedClaims: [],
    pipeline: {},
    readiness: "ready",
    createdAt: now,
    updatedAt: now
  });
}

// ---------------------------------------------------------------------------
// Resume styling. The canvas keeps its Tailwind classes (text-emerald,
// font-display, bg-mint, …); those tokens resolve to CSS variables (see
// tailwind-preset.ts), and this is the single place that computes the variable
// values from a `style`. Reused by the live canvas and the PDF render so they
// stay pixel-identical; the DOCX export mirrors the same logic with Word values.
// ---------------------------------------------------------------------------

// The three presets, fully resolved. Colors are space-separated "R G B" channels
// (the form the Tailwind tokens compose with <alpha-value>, so opacity modifiers
// like bg-mint/40 keep working). Serif presets are monochrome — accent and deep
// collapse to ink, highlight to a soft gray.
const PRESETS: Record<CvStyle["preset"], {
  fontBody: string; fontDisplay: string; accent: string; deep: string; highlight: string;
}> = {
  modern: {
    fontBody: "Inter, sans-serif",
    fontDisplay: "'Plus Jakarta Sans', Inter, sans-serif",
    accent: "5 150 105", deep: "6 101 70", highlight: "236 253 245"
  },
  garamond: {
    fontBody: "'EB Garamond', Garamond, serif",
    fontDisplay: "'EB Garamond', Garamond, serif",
    accent: "15 23 42", deep: "15 23 42", highlight: "241 245 249"
  },
  times: {
    fontBody: "'Times New Roman', Tinos, serif",
    fontDisplay: "'Times New Roman', Tinos, serif",
    accent: "15 23 42", deep: "15 23 42", highlight: "241 245 249"
  }
};

// Resolve a CvStyle into the CSS custom properties the canvas/PDF read. Returns
// a plain string map (not React.CSSProperties) so this file stays React-free;
// callers spread it into an element's inline style.
export function resumeStyleVars(style?: CvStyle): Record<string, string> {
  const p = PRESETS[cvStyleSchema.parse(style ?? {}).preset];
  return {
    "--cv-accent-rgb": p.accent,
    "--cv-accent-deep-rgb": p.deep,
    "--cv-highlight-rgb": p.highlight,
    "--cv-font-body": p.fontBody,
    "--cv-font-display": p.fontDisplay
  };
}

export { CvDocument, type ResumeDocument } from "./CvDocument.js";
