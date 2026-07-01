import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BaseProfile, JobDescription, TailoredCv } from "@cv-tailor/shared";

const execFileAsync = promisify(execFile);

const ENGINE_ROOT = process.env.CCC_ENGINE_ROOT || "";
const ENGINE_SCRIPT = ENGINE_ROOT ? join(ENGINE_ROOT, "engine", "run_resume_engine.py") : "";
const PYTHON = process.env.CCC_PYTHON || (ENGINE_ROOT ? join(ENGINE_ROOT, ".venv", "bin", "python3") : "");

// Parse the CCC engine's own .env file so its API keys are available to the
// subprocess even when the Node API was started without them in the environment.
function loadCccDotEnv(): Record<string, string> {
  if (!ENGINE_ROOT) return {};
  const envPath = join(ENGINE_ROOT, ".env");
  if (!existsSync(envPath)) return {};
  try {
    return Object.fromEntries(
      readFileSync(envPath, "utf8").split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => { const idx = line.indexOf("="); return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] as [string, string]; })
    );
  } catch { return {}; }
}

const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;

export function cccStatus() {
  const available = Boolean(ENGINE_ROOT) && existsSync(PYTHON) && existsSync(ENGINE_SCRIPT);
  return { available, engineRoot: ENGINE_ROOT, python: PYTHON };
}

export function isCccAvailable(): boolean {
  return cccStatus().available;
}

const stripHtml = (value: string) => value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// CCC emits a single "dates" string per role (e.g. "Jan 2020 – Dec 2021"); the
// extension model keeps startDate/endDate separately. Split on en-dash or hyphen.
function splitDateRange(dates: string): { startDate: string; endDate: string } {
  const parts = String(dates || "").split(/\s*[–—-]\s*/);
  if (parts.length >= 2) return { startDate: (parts[0] || "").trim(), endDate: parts.slice(1).join(" - ").trim() };
  return { startDate: String(dates || "").trim(), endDate: "" };
}

// ---- Inbound: extension BaseProfile -> CCC master_profile.json ----
function mapProfileToMaster(profile: BaseProfile) {
  const skills: Record<string, string[]> = Object.keys(profile.skillCategories || {}).length
    ? profile.skillCategories
    : { General: profile.skills };
  return {
    client: {
      name: profile.contact.name,
      email: profile.contact.email,
      phone: profile.contact.phone,
      city: profile.contact.location,
      country: "",
      linkedin: profile.contact.linkedIn,
      label: profile.targetRole
    },
    core_positioning: profile.positioning
      ? { level: profile.positioning.level, strategy: profile.positioning.strategy, notes: profile.positioning.notes }
      : {},
    summary_base: profile.summary ? [profile.summary] : [],
    experience: profile.experiences.map((experience) => ({
      company: experience.company,
      position: experience.role,
      location: "",
      startDate: experience.startDate,
      endDate: experience.endDate,
      summary: "",
      highlights: experience.bullets
    })),
    education: profile.education.map((entry) => ({
      institution: [entry.school, entry.location].filter(Boolean).join(", "),
      school: entry.school,
      degree: [entry.degree, entry.honors].filter(Boolean).join(", "),
      dates: entry.graduationDate,
      gpa: entry.gpa,
      note: entry.coursework.filter(Boolean).join("; ")
    })),
    skills,
    languages: profile.languages,
    certifications: profile.certifications
  };
}

// ---- Inbound: extension JobDescription -> CCC job file ----
function mapJobToCcc(job: JobDescription) {
  return {
    job_id: `cv-tailor-${Date.now()}`,
    Name: job.company,
    Status: "ad_hoc_extension",
    URL: job.url || "",
    position: job.title,
    note: "Created from Fyxor extension.",
    jd_text: job.description,
    searched_at: new Date().toISOString(),
    source_query: "extension-tailor"
  };
}

// The engine prints the run dir as its last stdout line. Scan bottom-up for an
// existing absolute path (mirrors ccc-resume-studio-lite/server.js extractRunDir).
function extractRunDir(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.startsWith("/") && existsSync(line)) return line;
  }
  return null;
}

// ---- Outbound: CCC resume.json -> extension TailoredCv ----
type CccResume = {
  name?: string; city?: string; phone?: string; email?: string; linkedin?: string;
  summary?: string;
  experience?: Array<{ title?: string; company?: string; location?: string; dates?: string; context?: string; bullets?: string[] }>;
  education?: Array<{ degree?: string; school?: string; location?: string; dates?: string; gpa?: string; honors?: string; note?: string }>;
  skills?: Record<string, string>;
  certifications?: string[];
  languages?: Array<{ language?: string; level?: string }>;
};

const normalizeMatchPart = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export function mapResumeToTailoredCv(resume: CccResume, profile: BaseProfile, job: JobDescription): TailoredCv {
  const now = new Date().toISOString();
  const usedSourceIds = new Set<string>();

  const findSourceExperienceId = (
    role: NonNullable<CccResume["experience"]>[number],
    index: number
  ): string => {
    const title = normalizeMatchPart(role.title || "");
    const company = normalizeMatchPart(role.company || "");
    const dates = splitDateRange(role.dates || "");
    const startDate = normalizeMatchPart(dates.startDate);
    const endDate = normalizeMatchPart(dates.endDate);
    const unused = profile.experiences.filter((experience) => !usedSourceIds.has(experience.id));

    const exact = unused.find((experience) =>
      normalizeMatchPart(experience.role) === title &&
      normalizeMatchPart(experience.company) === company
    );
    const companyAndDates = unused.find((experience) =>
      company &&
      normalizeMatchPart(experience.company) === company &&
      normalizeMatchPart(experience.startDate) === startDate &&
      normalizeMatchPart(experience.endDate) === endDate
    );
    const companyMatches = company
      ? unused.filter((experience) => normalizeMatchPart(experience.company) === company)
      : [];
    const uniqueCompany = companyMatches.length === 1 ? companyMatches[0] : undefined;
    const positional = profile.experiences[index] && !usedSourceIds.has(profile.experiences[index].id)
      ? profile.experiences[index]
      : unused[0];
    const source = exact || companyAndDates || uniqueCompany || positional;
    if (!source) return "";
    usedSourceIds.add(source.id);
    return source.id;
  };

  const skillCategories: Record<string, string[]> = {};
  for (const [category, value] of Object.entries(resume.skills || {})) {
    skillCategories[category] = String(value).split(",").map((s) => s.trim()).filter(Boolean);
  }
  const skills = Array.from(new Set(Object.values(skillCategories).flat()));

  return {
    id: crypto.randomUUID(),
    baseProfileId: profile.id,
    job,
    contact: {
      name: resume.name || profile.contact.name,
      email: resume.email || profile.contact.email,
      phone: resume.phone || profile.contact.phone,
      location: resume.city || profile.contact.location,
      linkedIn: resume.linkedin || profile.contact.linkedIn
    },
    summary: stripHtml(resume.summary || ""),
    summaryClaims: [],
    experiences: (resume.experience || []).map((role, index) => {
      const { startDate, endDate } = splitDateRange(role.dates || "");
      const sourceExperienceId = findSourceExperienceId(role, index);
      const source = profile.experiences.find((experience) => experience.id === sourceExperienceId);
      return {
        id: crypto.randomUUID(),
        company: role.company || "",
        role: role.title || "",
        originalRole: source?.role || role.title || "",
        titleEvidenceStatus: source && source.role !== (role.title || "") ? "needs-review" as const : "unchanged" as const,
        startDate,
        endDate,
        bullets: (role.bullets || []).map(stripHtml).filter(Boolean).map((text) => ({
          id: crypto.randomUUID(),
          text,
          sourceBulletIndexes: [],
          evidenceStatus: "legacy-unverified" as const
        })),
        sourceExperienceId,
        sourceBulletIndexes: []
      };
    }),
    education: (resume.education || []).map((entry) => ({
      id: crypto.randomUUID(),
      school: entry.school || "",
      degree: entry.degree || "",
      location: entry.location || "",
      graduationDate: entry.dates || "",
      gpa: entry.gpa || "",
      honors: entry.honors || "",
      coursework: entry.note ? entry.note.split(/;|\n/).map((s) => s.trim()).filter(Boolean) : []
    })),
    skills,
    skillEvidence: [],
    skillCategories,
    certifications: resume.certifications || [],
    languages: (resume.languages && resume.languages.length
      ? resume.languages.map((l) => ({ language: l.language || "", level: l.level || "" }))
      : profile.languages),
    sectionOrder: profile.sectionOrder ?? [],
    style: profile.style,
    dismissedChecks: [],
    unsupportedClaims: [],
    pipeline: { pipelineVersion: "legacy-ccc", runId: "", provider: "", model: "", legacyEngine: "ccc", stages: [], aiCallCount: 0, repairCount: 0 },
    readiness: "needs-source-update",
    createdAt: now,
    updatedAt: now
  };
}

export async function runCccEngine(profile: BaseProfile, job: JobDescription): Promise<TailoredCv> {
  if (!isCccAvailable()) {
    throw new Error(`CCC engine not configured. Set CCC_ENGINE_ROOT (and create its .venv) — looked for ${ENGINE_SCRIPT || "<unset>"} and ${PYTHON || "<unset>"}.`);
  }

  const directory = await mkdtemp(join(tmpdir(), "cv-tailor-ccc-"));
  const profileFile = join(directory, "master_profile.json");
  const jobFile = join(directory, "job.json");
  const outputDir = join(directory, "runs");

  try {
    await writeFile(profileFile, JSON.stringify(mapProfileToMaster(profile), null, 2));
    await writeFile(jobFile, JSON.stringify(mapJobToCcc(job), null, 2));

    const cccEnv = loadCccDotEnv();
    const mergedEnv = { ...cccEnv, ...process.env } as Record<string, string>;

    const providerArgs = [
      "--llm-provider", "openai",
      "--openai-api-key", mergedEnv.DEEPSEEK_API_KEY || "",
      "--openai-model", mergedEnv.DEEPSEEK_MODEL || "deepseek-v4-flash",
      "--openai-base-url", "https://api.deepseek.com",
    ];

    const args = [
      ENGINE_SCRIPT,
      "--client-name", profile.contact.name || "candidate",
      "--profile-file", profileFile,
      "--job-file", jobFile,
      "--output-dir", outputDir,
      ...providerArgs,
    ];

    const startedAt = Date.now();
    console.log(`[ccc] start provider=deepseek model=${mergedEnv.DEEPSEEK_MODEL || "deepseek-v4-flash"}`);
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync(PYTHON, args, {
        cwd: ENGINE_ROOT,
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: mergedEnv
      }));
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const runDir = extractRunDir(err.stdout || "");
      const errorTxt = runDir && existsSync(join(runDir, "error.txt"))
        ? await readFile(join(runDir, "error.txt"), "utf8").catch(() => "")
        : "";
      console.log(`[ccc] failed after ${Date.now() - startedAt}ms`);
      throw new Error(`CCC engine run failed. ${errorTxt.trim() || (err.stderr || "").trim() || err.message || "Unknown error"}`);
    }

    const runDir = extractRunDir(stdout);
    console.log(`[ccc] done in ${Date.now() - startedAt}ms (runDir=${runDir})`);
    if (!runDir) throw new Error("CCC engine did not report a run directory.");
    const resumePath = join(runDir, "resume.json");
    if (!existsSync(resumePath)) {
      const errorTxt = existsSync(join(runDir, "error.txt")) ? await readFile(join(runDir, "error.txt"), "utf8").catch(() => "") : "";
      throw new Error(`CCC engine produced no resume.json. ${errorTxt.trim()}`);
    }
    const resume = JSON.parse(await readFile(resumePath, "utf8")) as CccResume;
    return mapResumeToTailoredCv(resume, profile, job);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
