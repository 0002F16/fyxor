import { z } from "zod";

export const outputLanguageSchema = z.enum(["en", "pl"]);
export const aiProviderSchema = z.enum(["codex-local", "openai-api", "gemini-api", "groq-api"]);
export const tailoringEngineSchema = z.enum(["builtin", "ccc"]);

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
  outputLanguage: outputLanguageSchema.default("en"),
  summary: z.string().default(""),
  experiences: z.array(experienceSchema).default([]),
  education: educationArraySchema,
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
  sourceBulletIndexes: z.array(z.number().int().nonnegative()).default([])
});

export const unsupportedClaimSchema = z.object({
  section: z.string(),
  text: z.string(),
  reason: z.string()
});

export const tailoredCvSchema = z.object({
  id: z.string(),
  baseProfileId: z.string(),
  job: jobDescriptionSchema,
  outputLanguage: outputLanguageSchema,
  contact: contactSchema,
  summary: z.string(),
  experiences: z.array(tailoredExperienceSchema),
  education: educationArraySchema,
  skills: z.array(z.string()),
  skillCategories: z.record(z.array(z.string())).default({}),
  certifications: z.array(z.string()).default([]),
  languages: z.array(languageSchema).default([]),
  sectionOrder: z.array(z.string()).default([]),
  style: cvStyleSchema.default({}),
  dismissedChecks: z.array(z.string()).default([]),
  unsupportedClaims: z.array(unsupportedClaimSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const applicationRecordSchema = z.object({
  id: z.string(),
  job: jobDescriptionSchema,
  tailoredCv: tailoredCvSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const regenerationRequestSchema = z.object({
  profile: baseProfileSchema,
  cv: tailoredCvSchema,
  section: z.enum(["summary", "experience", "skills"]),
  experienceId: z.string().optional()
});

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
  // Stable identifier of the job this run belongs to (see `tailoringJobKey`), so
  // the popup can tell whether a stored running/done/error slot actually refers
  // to the job currently on screen — preventing a finished job from hijacking
  // the UI for a different, freshly selected job.
  jobKey: z.string().default(""),
  // Epoch ms when a "running" job started, so the popup can detect a run
  // orphaned by a terminated service worker and surface it as an error.
  startedAt: z.number().default(0)
});

export const storageStateSchema = z.object({
  version: z.literal(1),
  profile: baseProfileSchema.nullable(),
  drafts: z.record(tailoredCvSchema),
  applications: z.array(applicationRecordSchema),
  pendingJob: jobDescriptionSchema.nullable().default(null),
  tailoringJob: tailoringJobSchema.nullable().default(null),
  auth: authSessionSchema.nullable().default(null),
  settings: z.object({
    apiBaseUrl: z.string().default("https://api-76-13-177-250.sslip.io"),
    aiProvider: aiProviderSchema.default("gemini-api"),
    tailoringEngine: tailoringEngineSchema.default("builtin"),
    onboardingComplete: z.boolean().default(false),
    welcomeSeen: z.boolean().default(false),
    pinScreenSeen: z.boolean().default(false),
    inlineEditHintSeen: z.boolean().default(false),
    resumeStrengthHidden: z.boolean().default(false)
  })
});

export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type BaseProfile = z.infer<typeof baseProfileSchema>;
export type JobDescription = z.infer<typeof jobDescriptionSchema>;
export type TailoredCv = z.infer<typeof tailoredCvSchema>;
export type ApplicationRecord = z.infer<typeof applicationRecordSchema>;
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
  version: 1,
  profile: null,
  drafts: {},
  applications: [],
  pendingJob: null,
  tailoringJob: null,
  auth: null,
  settings: {
    apiBaseUrl: "http://127.0.0.1:8787",
    aiProvider: "gemini-api",
    tailoringEngine: "ccc",
    onboardingComplete: false,
    welcomeSeen: false,
    pinScreenSeen: false,
    inlineEditHintSeen: false,
    resumeStrengthHidden: false
  }
});

const VPS_API_URL = "https://api-76-13-177-250.sslip.io";
const LOCAL_URL = "http://127.0.0.1:8787";

export function migrateStorage(input: unknown): StorageState {
  const parsed = storageStateSchema.safeParse(input);
  const state = parsed.success ? parsed.data : emptyStorageState();
  // Temporarily remapping to local for dev testing — swap back when pointing at VPS again.
  if (state.settings.apiBaseUrl === VPS_API_URL) {
    state.settings.apiBaseUrl = LOCAL_URL;
  }
  // Codex CLI is no longer supported — fall back to Gemini.
  if (state.settings.aiProvider === "codex-local") {
    state.settings.aiProvider = "gemini-api";
  }
  return state;
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
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
  regenerated: TailoredCv,
  section: "summary" | "experience" | "skills",
  experienceId?: string
): TailoredCv {
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
