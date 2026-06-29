import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, BriefcaseBusiness, Check, ChevronDown, Cloud, CloudOff,
  Copy, Download, Eye, ExternalLink, FilePenLine, FileText, Files, Lightbulb, LoaderCircle, LogOut,
  MoreVertical, MousePointerClick, Palette, PenLine, Pin, Plus, Reply, Save, Send, Sparkles,
  Trash2, Upload, X
} from "lucide-react";
import {
  applyRegeneratedSection,
  bulletHasMetric,
  cvStyleSchema,
  educationHasContent,
  effectiveSectionOrder,
  emptyStorageState,
  flattenSkillCategories,
  makeId,
  markTailoredTextStale,
  migrateStorage,
  missingStructuredProfileEvidence,
  normalizeSkillCategories,
  resumeStyleVars,
  type ApplicationRecord,
  type ApplicationStatus,
  type AiProvider,
  type BaseProfile,
  type CvStyle,
  type JobDescription,
  type StorageState,
  type TailoredCv
} from "@cv-tailor/shared";
import { api, ApiError, AuthExpiredError } from "./api";
import { authClient } from "./auth";
import { CvDocument } from "@cv-tailor/shared";
import { PaginatedPreview } from "./PaginatedPreview";
import { ResumeStrength } from "./ResumeStrength";
import { evaluateResume, sectionCompleteness, type ProfileSectionId } from "./resumeChecks";
import { clearAuthSession, clearAuthToken, getState, setAuthSession, setState, updateState } from "./storage";

// Centralized handling for an expired session (401). Drops only the local bearer
// token so the app falls back to the sign-in gate, but KEEPS local data — it may
// hold edits sync never managed to push, and wiping them would be silent data
// loss. Returns true when handled as an expiry, so callers can skip the inline
// error and let the gate take over.
async function handleAuthExpiry(error: unknown, onChange: (s: StorageState) => void): Promise<boolean> {
  if (error instanceof AuthExpiredError) {
    onChange(await clearAuthToken());
    return true;
  }
  return false;
}

function Logo() {
  return <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-emerald to-deep text-white shadow-soft"><Check size={18} strokeWidth={3} /></span>;
}

function Loading({ label = "Working…" }: { label?: string }) {
  return <div className="flex items-center gap-2 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" />{label}</div>;
}

// Hands a dropped file from the Welcome hero to the Onboarding component across the
// hash navigation (same SPA render, no reload) so the user isn't asked to pick the
// file twice. Consumed once on Onboarding mount, then cleared.
let pendingUploadFile: File | null = null;

// Turns the 10–30s parse+extract wait into a sense of forward motion: each stage
// reveals in turn — done stages get a check, the active one spins, later ones stay
// muted. Advances on a gentle timer (we have no real per-stage signal) and falls
// back to a single static line when the user prefers reduced motion.
function StagedLoader({ stages }: { stages: string[] }) {
  const [active, setActive] = useState(0);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setActive((i) => Math.min(i + 1, stages.length - 1)), 4200);
    return () => clearInterval(id);
  }, [stages.length, reduced]);
  if (reduced) return <Loading label="Building your profile…" />;
  return <ul className="space-y-2.5">
    {stages.map((stage, i) => <li key={stage} className="flex items-center gap-2.5 text-sm onboarding-rise" style={{ animationDelay: `${i * 60}ms` }}>
      {i < active
        ? <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald text-white"><Check size={12} strokeWidth={3} /></span>
        : i === active
          ? <LoaderCircle size={20} className="animate-spin text-emerald" />
          : <span className="h-5 w-5 rounded-full border-2 border-line" />}
      <span className={i <= active ? "font-medium text-ink" : "text-muted"}>{stage}</span>
    </li>)}
  </ul>;
}

function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div>;
}

type SaveState = "idle" | "saving" | "saved";

// Small live autosave indicator. Driven by the debounced save effects so the
// user can see their edits are persisted instead of trusting static copy.
function SaveStatus({ state }: { state: SaveState }) {
  if (state === "saving") return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted"><LoaderCircle size={13} className="animate-spin" /> Saving…</span>;
  if (state === "saved") return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald"><Check size={13} /> Saved</span>;
  return <span className="text-xs text-muted">Autosaves as you type</span>;
}

type SyncState = "synced" | "offline" | "idle";

// Honest cloud-sync status so the "available on any device" promise isn't shown
// when the last push actually failed (offline).
function SyncIndicator({ state }: { state: SyncState }) {
  if (state === "offline") return <p className="mt-3 flex items-start gap-2 text-sm text-amber-700"><CloudOff size={16} className="mt-0.5 shrink-0" /> Offline — changes are saved on this device and will sync when you reconnect.</p>;
  if (state === "synced") return <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Cloud size={16} className="text-emerald" /> Synced to your account — available on any device.</p>;
  return <p className="mt-3 text-sm text-muted">Your CV and applications sync to your account, so they're safe and available on any device.</p>;
}

// Tracks autosave status for a canvas. `editing()` is called on each user edit;
// `saved()` is called when the debounced write resolves and only confirms if a
// save was actually pending (so it never flashes on initial mount).
function useSaveStatus() {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const fade = useRef<ReturnType<typeof setTimeout>>();
  const editing = () => { if (fade.current) clearTimeout(fade.current); setSaveState("saving"); };
  const saved = () => setSaveState((s) => {
    if (s !== "saving") return s;
    if (fade.current) clearTimeout(fade.current);
    fade.current = setTimeout(() => setSaveState("idle"), 2000);
    return "saved";
  });
  return { saveState, markEdited: { editing, saved } };
}

// Shared empty state for the Home and Applications screens — single source of
// truth for the "send a job offer" instructions.
function EmptyApplications({ extra }: { extra?: string }) {
  return <div className="card py-16 text-center">
    <BriefcaseBusiness className="mx-auto text-emerald" size={32} />
    <h2 className="mt-4 section-title">No tailored jobs yet</h2>
    <p className="mx-auto mt-2 max-w-md text-sm text-muted">Click the extension icon on any job post, then send the offer to Fyxor. LinkedIn jobs are detected automatically.{extra ? ` ${extra}` : ""}</p>
  </div>;
}

// Sidebar card explaining inline editing, now also surfacing the live save state.
function InlineEditHint({ children, saveState }: { children: React.ReactNode; saveState?: SaveState }) {
  return <div className="card">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold"><FilePenLine size={16} className="text-emerald" /> Edit on the page</div>
      {saveState && <SaveStatus state={saveState} />}
    </div>
    <p className="mt-1 text-xs text-muted">{children}</p>
  </div>;
}

// Sidebar resume-completeness panel. Respects the global hide setting: when
// hidden it collapses to a small "Show resume tips" link so the user can bring
// it back. `onDismiss` records an ignored check id on the document being edited.
function StrengthPanel({ state, doc, kind, onDismiss, onChange }: {
  state: StorageState;
  doc: Parameters<typeof evaluateResume>[0];
  kind: "base" | "tailored";
  onDismiss: (id: string) => void;
  onChange: (s: StorageState) => void;
}) {
  const strength = useMemo(() => evaluateResume(doc, kind, doc.dismissedChecks ?? []), [doc, kind]);
  async function setHidden(hidden: boolean) {
    onChange(await updateState((s) => ({ ...s, settings: { ...s.settings, resumeStrengthHidden: hidden } })));
  }
  if (state.settings.resumeStrengthHidden) {
    return <button className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-emerald hover:underline" onClick={() => setHidden(false)}><Lightbulb size={14} /> Show resume tips</button>;
  }
  return <ResumeStrength strength={strength} onDismiss={onDismiss} onHide={() => setHidden(true)} />;
}

function QualitySignals({ cv }: { cv: TailoredCv }) {
  const [open, setOpen] = useState(true);
  const dimensions = [
    ["truthfulness", "Evidence"],
    ["relevance", "Relevance"],
    ["readability", "Readability"],
    ["ats", "ATS & format"],
    ["appropriateness", "Appropriateness"]
  ] as const;
  const findings = cv.evaluation?.checks.filter((finding) => finding.status !== "pass") ?? [];
  const scores = dimensions.map(([key]) => cv.evaluation?.scores[key]).filter((s): s is number => s != null);
  const overall = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const ready = cv.readiness === "ready";
  return <div className="card">
    <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)}>
      <span className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-emerald" /> Quality review</span>
      <span className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${ready ? "bg-mint text-deep" : "bg-red-50 text-red-700"}`}>{cv.readiness.replaceAll("-", " ")}</span>
        <ChevronDown size={15} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </span>
    </button>
    {overall != null && <div className="mt-3">
      <div className="flex items-center justify-between text-[11px] font-semibold"><span className="text-muted">Overall</span><span className={overall >= 80 ? "text-emerald" : "text-amber-600"}>{overall}%</span></div>
      <div className="quality-bar mt-1"><div className={`quality-bar-fill ${overall >= 80 ? "is-ok" : "is-warn"}`} style={{ width: `${overall}%` }} /></div>
    </div>}
    {open && <>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {dimensions.map(([key, label]) => {
          const score = cv.evaluation?.scores[key];
          return <div key={key} className="rounded-lg border border-line px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</p>
            <p className={`text-sm font-bold ${(score ?? 0) >= 80 ? "text-emerald" : "text-amber-600"}`}>{score == null ? "Pending" : `${score}%`}</p>
          </div>;
        })}
      </div>
      {findings.length > 0 && <div className="mt-3 space-y-2">
        {findings.slice(0, 6).map((finding) => <div key={finding.id} className={`rounded-lg border p-2 text-xs ${finding.status === "fail" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          <p className="font-semibold">{finding.label}</p><p className="mt-0.5">{finding.detail}</p>
        </div>)}
        {!ready && <button className="btn-secondary w-full text-xs" onClick={() => { location.hash = "#resume"; }}>Add missing evidence to base CV</button>}
      </div>}
      <p className="mt-3 text-[10px] text-muted">{cv.pipeline.pipelineVersion} · {cv.pipeline.aiCallCount} AI calls{cv.pipeline.model ? ` · ${cv.pipeline.model}` : ""}</p>
    </>}
  </div>;
}

// One-time, dismissible nudge so first-time users discover the canvas is editable.
function FirstEditHint({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [dismissed, setDismissed] = useState(state.settings.inlineEditHintSeen);
  if (dismissed) return null;
  async function close() {
    setDismissed(true);
    onChange(await updateState((s) => ({ ...s, settings: { ...s.settings, inlineEditHintSeen: true } })));
  }
  return <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald/30 bg-mint/60 px-3 py-2 text-sm text-deep">
    <MousePointerClick size={16} className="shrink-0 text-emerald" />
    <span className="flex-1">Click any line to edit it — changes autosave.</span>
    <button aria-label="Dismiss hint" className="rounded-lg p-1 text-deep/70 hover:bg-white/60 hover:text-deep" onClick={close}><X size={15} /></button>
  </div>;
}

const NAV_ITEMS = [
  { hash: "#home", label: "Home" },
  { hash: "#resume", label: "Your Resume" },
  { hash: "#applications", label: "Applications" },
  { hash: "#account", label: "Account" }
] as const;

// Maps any in-app route to the nav item that should read as active, so the
// highlighted tab always matches the rendered screen (e.g. #tracker→Applications).
function activeNavHash(hash: string) {
  const h = hash || "#home";
  if (h === "#tracker" || h.startsWith("#editor")) return "#applications";
  if (h === "#profile") return "#account";
  if (NAV_ITEMS.some((item) => item.hash === h)) return h;
  return "";
}

function Shell({ children, title, eyebrow }: { children: React.ReactNode; title: string; eyebrow?: string }) {
  const nav = (hash: string) => { location.hash = hash; };
  const active = activeNavHash(location.hash);
  return (
    <div className="min-h-screen bg-soft">
      <header className="sticky top-0 z-10 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 max-w-6xl">
          <button className="flex items-center gap-2.5" onClick={() => nav("#home")}><Logo /><span className="font-display font-bold">Fyxor</span></button>
          <nav className="flex flex-wrap gap-1.5">
            {NAV_ITEMS.map(({ hash, label }) => {
              const isActive = active === hash;
              return (
                <button key={hash} onClick={() => nav(hash)} aria-current={isActive ? "page" : undefined}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${isActive ? "bg-mint text-deep" : "text-muted hover:bg-soft hover:text-ink"}`}>
                  {label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto px-4 py-6 max-w-6xl">
        <div className="mb-5">{eyebrow && <p className="text-xs font-semibold uppercase tracking-[.1em] text-emerald">{eyebrow}</p>}<h1 className="mt-1 font-display text-2xl font-bold tracking-tight">{title}</h1></div>
        {children}
      </main>
    </div>
  );
}

function openFullPage(hash: string) {
  const url = globalThis.chrome?.runtime ? chrome.runtime.getURL(`index.html${hash}`) : hash;
  if (globalThis.chrome?.tabs) chrome.tabs.create({ url });
  else location.hash = hash;
}

async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

// Comma-separated skills input. Keeps raw text locally so typing commas/spaces
// isn't stripped by the parse round-trip, re-syncs when the value changes
// externally (e.g. AI fill) while unfocused, and commits parsed entries on blur.
function SkillEntriesInput({ entries, onCommit }: { entries: string[]; onCommit: (next: string[]) => void }) {
  const [text, setText] = useState(entries.join(", "));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(entries.join(", ")); }, [entries]);
  const commit = () => { focused.current = false; onCommit(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)); };
  return <textarea className="field mt-2 min-h-20" placeholder="Comma-separated skills, e.g. Python, TypeScript, Go"
    value={text} onFocus={() => { focused.current = true; }} onBlur={commit} onChange={(e) => setText(e.target.value)} />;
}

// Chip/tag entry for a flat skills list: type a skill and press Enter or comma to
// add it, click the × (or Backspace on an empty input) to remove. The flat list is
// the source of truth; "Group with AI" turns it into themed categories afterwards.
function SkillChips({ skills, onChange }: { skills: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...skills];
    for (const part of parts) if (!next.some((s) => s.toLowerCase() === part.toLowerCase())) next.push(part);
    onChange(next);
    setText("");
  };
  return <div className="mt-2 flex min-h-20 w-full flex-wrap content-start gap-2 rounded-xl border border-line bg-white px-3 py-2.5 text-sm transition focus-within:border-emerald focus-within:ring-2 focus-within:ring-emerald/15">
    {skills.map((skill, index) => <span className="chip inline-flex items-center gap-1" key={index}>{skill}
      <button type="button" aria-label={`Remove ${skill}`} className="text-deep/60 hover:text-deep" onClick={() => onChange(skills.filter((_, i) => i !== index))}><X size={12} /></button>
    </span>)}
    <input className="min-w-[10ch] flex-1 bg-transparent outline-none" placeholder={skills.length ? "Add another…" : "Type a skill and press Enter"}
      value={text} onChange={(e) => setText(e.target.value)} onBlur={() => add(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(text); }
        else if (e.key === "Backspace" && !text && skills.length) onChange(skills.slice(0, -1));
      }} />
  </div>;
}

// Onboarding is a small view machine. The parse path is short — source → summary
// (smart auto-skip review cards) → final review — while the manual path walks the
// full section flow. Both share one set of section editors.
type OnbView = "source" | "summary" | ProfileSectionId | "review";
const MANUAL_FLOW: OnbView[] = ["basics", "experience", "skills", "education", "extras", "review"];
const MANUAL_STEPS: OnbView[] = ["basics", "experience", "skills", "education", "extras"];
const ONB_VIEWS: OnbView[] = ["source", "summary", "basics", "experience", "skills", "education", "extras", "review"];
const SECTION_META: Record<ProfileSectionId, { title: string; blurb: string }> = {
  basics: { title: "The basics", blurb: "These details appear at the top of every tailored CV." },
  experience: { title: "Your experience", blurb: "Add real duties and achievements. Tailoring reframes these — it never invents them." },
  skills: { title: "Your skills", blurb: "Add your skills, then let AI sort them into clean, resume-ready groups." },
  education: { title: "Education", blurb: "Add your degree or qualifications so the resume isn't missing a section recruiters expect." },
  extras: { title: "Certifications & languages", blurb: "Optional — leave anything blank if it doesn't apply." }
};

function Onboarding({ state, onChange, initialMode = "upload", initialView }: { state: StorageState; onChange: (s: StorageState) => void; initialMode?: "upload" | "manual"; initialView?: OnbView }) {
  const initialProfile: BaseProfile = state.profile || {
    id: makeId("profile"), contact: { name: "", email: "", phone: "", location: "", linkedIn: "" },
    targetRole: "", summary: "", experiences: [], education: [], skills: [], skillCategories: {}, certifications: [], languages: [], sectionOrder: [], style: { preset: "modern" }, dismissedChecks: [], rawText: "", updatedAt: new Date().toISOString()
  };
  const savedStep = state.settings.onboardingStep as OnbView;
  const [view, setView] = useState<OnbView>(
    state.profile && !state.settings.onboardingComplete && ONB_VIEWS.includes(savedStep)
      ? savedStep
      : initialView ?? (initialMode === "manual" ? "basics" : "source")
  );
  const [rawText, setRawText] = useState(state.profile?.rawText || "");
  const [profile, setProfile] = useState<BaseProfile>(initialProfile);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Summary cards: ⚠ (incomplete) sections start expanded so the only sections the
  // user is nudged to touch are the ones that actually need it.
  const [expanded, setExpanded] = useState<Set<ProfileSectionId>>(() => new Set(sectionCompleteness(initialProfile).filter((s) => !s.complete).map((s) => s.id)));
  // Holds the last grouping so "Remove grouping" can be undone instead of silently
  // wiping hand-edited categories.
  const [groupingUndo, setGroupingUndo] = useState<Record<string, string[]> | null>(null);
  const mounted = useRef(false);
  const base = state.settings.apiBaseUrl;
  const provider = state.settings.aiProvider;

  // A file dropped on the Welcome hero is handed over here — run the full
  // parse→structure in one shot so an uploaded resume lands on the summary.
  useEffect(() => {
    if (pendingUploadFile && view === "source") { const file = pendingUploadFile; pendingUploadFile = null; runUpload(file); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave the in-progress profile and the current view, so a refresh or crash
  // resumes exactly here. Never flips onboardingComplete (that's finish()'s job);
  // skips the first render and the pre-parse source screen (no real profile yet).
  useEffect(() => {
    if (state.settings.onboardingComplete || view === "source") return;
    if (!mounted.current) { mounted.current = true; return; }
    const timer = setTimeout(() => {
      updateState((s) => ({ ...s, profile: { ...profile, rawText, updatedAt: new Date().toISOString() }, settings: { ...s.settings, onboardingStep: view } })).then(onChange);
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, rawText, view]);

  function landOnSummary(result: BaseProfile) {
    setProfile(result);
    setExpanded(new Set(sectionCompleteness(result).filter((s) => !s.complete).map((s) => s.id)));
    setView("summary");
  }

  // One-action upload: parse the file to text, then immediately structure it.
  async function runUpload(file: File) {
    setBusy("structuring"); setError("");
    try {
      const parsed = await api.parseFile(base, provider, await fileToBase64(file), file.name);
      setRawText(parsed.text);
      if (parsed.text.trim().length < 30) { setError("We couldn't read enough text from that file. Try pasting your CV text instead."); return; }
      landOnSummary(await api.extract(base, provider, parsed.text));
    } catch (e) { if (!(await handleAuthExpiry(e, onChange))) setError((e as Error).message); }
    finally { setBusy(""); }
  }

  async function structure() {
    if (rawText.trim().length < 30) return setError("Paste or upload enough CV text first.");
    setBusy("structuring"); setError("");
    try {
      landOnSummary(await api.extract(base, provider, rawText));
    } catch (e) { if (!(await handleAuthExpiry(e, onChange))) setError((e as Error).message); }
    finally { setBusy(""); }
  }

  function addExperience() {
    setProfile({ ...profile, experiences: [...profile.experiences, { id: makeId("exp"), company: "", role: "", startDate: "", endDate: "", bullets: [""] }] });
  }

  function removeExperience(id: string) {
    setProfile({ ...profile, experiences: profile.experiences.filter((x) => x.id !== id) });
  }

  function updateExperience(id: string, patch: Partial<BaseProfile["experiences"][number]>) {
    setProfile({ ...profile, experiences: profile.experiences.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  }

  function addEducation() {
    setProfile({ ...profile, education: [...profile.education, { id: makeId("edu"), school: "", degree: "", location: "", graduationDate: "", gpa: "", honors: "", coursework: [] }] });
  }

  function removeEducation(id: string) {
    setProfile({ ...profile, education: profile.education.filter((x) => x.id !== id) });
  }

  function updateEducation(id: string, patch: Partial<BaseProfile["education"][number]>) {
    setProfile({ ...profile, education: profile.education.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  }

  function addLanguage() {
    setProfile({ ...profile, languages: [...profile.languages, { language: "", level: "" }] });
  }

  function removeLanguage(index: number) {
    setProfile({ ...profile, languages: profile.languages.filter((_, i) => i !== index) });
  }

  function updateLanguage(index: number, patch: Partial<BaseProfile["languages"][number]>) {
    setProfile({ ...profile, languages: profile.languages.map((x, i) => (i === index ? { ...x, ...patch } : x)) });
  }

  // Themed skill categories, normalized so AI suggestions render pre-filled and a
  // fresh manual setup starts with one empty group. Every edit keeps the flat
  // `skills` union in sync (export/stats/CCC read it).
  const skillCategories = normalizeSkillCategories(profile.skillCategories, profile.skills, true);
  const hasSkillCategories = Object.keys(profile.skillCategories).length > 0;
  function writeSkillCategories(cats: Array<[string, string[]]>) {
    // Deduplicate keys before Object.fromEntries: two categories with the same
    // name (including both empty) would silently collapse into one without this.
    const seen = new Set<string>();
    const deduped = cats.map(([name, entries]): [string, string[]] => {
      let key = name;
      let i = 2;
      while (seen.has(key)) key = name ? `${name} ${i++}` : `${i++}`;
      seen.add(key);
      return [key, entries];
    });
    setProfile({ ...profile, skillCategories: Object.fromEntries(deduped), skills: flattenSkillCategories(deduped) });
  }
  // Chip edits write the flat list and drop any existing grouping — the user can
  // re-run "Group with AI" once the list is complete.
  function setSkills(next: string[]) {
    setProfile({ ...profile, skills: next, skillCategories: {} });
  }
  async function groupSkills() {
    if (!profile.skills.length) return;
    setBusy("Grouping your skills…"); setError("");
    try {
      const result = await api.categorizeSkills(base, provider, profile.skills, profile.targetRole);
      setProfile({ ...profile, skillCategories: result.skillCategories, skills: result.skills });
    } catch (e) { if (!(await handleAuthExpiry(e, onChange))) setError((e as Error).message); }
    finally { setBusy(""); }
  }
  function renameCategory(index: number, name: string) {
    writeSkillCategories(skillCategories.map((cat, i) => (i === index ? [name, cat[1]] : cat)));
  }
  function editCategoryEntries(index: number, entries: string[]) {
    writeSkillCategories(skillCategories.map((cat, i) => (i === index ? [cat[0], entries] : cat)));
  }
  function addCategory() {
    writeSkillCategories([...skillCategories, ["", []]]);
  }
  function removeCategory(index: number) {
    writeSkillCategories(skillCategories.filter((_, i) => i !== index));
  }
  // Non-destructive: stash the grouping so it can be restored, then flatten.
  function removeGrouping() {
    setGroupingUndo(profile.skillCategories);
    setProfile({ ...profile, skillCategories: {}, skills: flattenSkillCategories(skillCategories) });
  }
  function undoRemoveGrouping() {
    if (!groupingUndo) return;
    setProfile({ ...profile, skillCategories: groupingUndo, skills: flattenSkillCategories(normalizeSkillCategories(groupingUndo, profile.skills)) });
    setGroupingUndo(null);
  }

  async function finish() {
    const next = { ...state, profile: { ...profile, rawText, updatedAt: new Date().toISOString() }, settings: { ...state.settings, onboardingComplete: true, onboardingStep: "" } };
    await setState(next); onChange(next); location.hash = "#pin";
  }

  const BASIC_FIELDS = [
    { key: "name", label: "Full name *", placeholder: "Jane Doe", required: true },
    { key: "email", label: "Email *", placeholder: "you@example.com", required: true },
    { key: "phone", label: "Phone", placeholder: "+44 7700 900000", required: false },
    { key: "location", label: "Location", placeholder: "London, UK", required: false },
    { key: "linkedIn", label: "LinkedIn profile URL", placeholder: "https://linkedin.com/in/…", required: false }
  ] as const;

  // Required basics let the user finish early instead of walking every section.
  const basicsValid = profile.contact.name.trim().length > 0 && profile.contact.email.trim().length > 0;
  const sections = sectionCompleteness(profile);
  const incomplete = sections.filter((s) => !s.complete);
  const pctComplete = Math.round((sections.filter((s) => s.complete).length / sections.length) * 100);
  const toggleExpanded = (id: ProfileSectionId) => setExpanded((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const renderBasics = () => <>
    <div className="grid gap-4 sm:grid-cols-2">
      {BASIC_FIELDS.map(({ key, label, placeholder, required }) => <label key={key}><span className="label">{label}</span><input className="field" required={required} placeholder={placeholder} value={profile.contact[key]} onChange={(e) => setProfile({ ...profile, contact: { ...profile.contact, [key]: e.target.value } })} /></label>)}
      <label><span className="label">Target role</span><input className="field" placeholder="Senior Product Designer" value={profile.targetRole} onChange={(e) => setProfile({ ...profile, targetRole: e.target.value })} /></label>
    </div>
    <label className="mt-4 block"><span className="label">Professional summary</span><textarea className="field min-h-28" placeholder="Two or three lines on who you are and the impact you've had." value={profile.summary} onChange={(e) => setProfile({ ...profile, summary: e.target.value })} /></label>
  </>;

  const renderExperience = () => <>
    <div className="space-y-4">{profile.experiences.map((experience) => <div className="rounded-2xl border border-line bg-soft p-4" key={experience.id}>
      <div className="grid gap-3 sm:grid-cols-2">
        <input className="field" placeholder="Role — e.g. Senior Product Designer" value={experience.role} onChange={(e) => updateExperience(experience.id, { role: e.target.value })} />
        <input className="field" placeholder="Company — e.g. Acme" value={experience.company} onChange={(e) => updateExperience(experience.id, { company: e.target.value })} />
        <input className="field" placeholder="Start (e.g. Jan 2021)" value={experience.startDate} onChange={(e) => updateExperience(experience.id, { startDate: e.target.value })} />
        <input className="field" placeholder="End (e.g. Present)" value={experience.endDate} onChange={(e) => updateExperience(experience.id, { endDate: e.target.value })} />
      </div>
      <textarea className="field mt-3 min-h-28" placeholder="One bullet per line — e.g. Cut onboarding drop-off 32% by redesigning the signup flow" value={experience.bullets.join("\n")} onChange={(e) => updateExperience(experience.id, { bullets: e.target.value.split("\n") })} />
      {experience.bullets.some((b) => b.trim()) && !experience.bullets.some(bulletHasMetric) && <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600"><Lightbulb size={14} className="mt-px shrink-0" /> Add a number where you can — e.g. "cut deploy time 40%" or "led a team of 6". Metrics make tailoring far stronger.</p>}
      <div className="mt-3 flex justify-end"><button className="btn-secondary !px-3 text-red-600" onClick={() => removeExperience(experience.id)}><Trash2 size={15} /> Remove role</button></div>
    </div>)}</div>
    <button className="mt-4 btn-secondary" onClick={addExperience}><Plus size={16} /> {profile.experiences.length ? "Add another role" : "Add your first role"}</button>
  </>;

  const renderSkills = () => <>
    {!hasSkillCategories ? <>
      <div className="flex items-center justify-between"><span className="label !mb-0">Your skills</span><button className="btn-secondary !px-3 !py-1.5 text-sm" disabled={!!busy || !profile.skills.length} onClick={groupSkills}>{busy === "Grouping your skills…" ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />} Group with AI</button></div>
      <SkillChips skills={profile.skills} onChange={setSkills} />
      {groupingUndo && <button className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald hover:underline" onClick={undoRemoveGrouping}><Reply size={13} /> Undo remove grouping</button>}
    </> : <>
      <div className="flex items-center justify-between">
        <span className="label !mb-0">Skill categories</span>
        <div className="flex items-center gap-2">
          <button className="btn-secondary !px-3 !py-1.5 text-sm text-muted" onClick={removeGrouping}>Remove grouping</button>
          <button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={addCategory}><Plus size={15} /> Category</button>
        </div>
      </div>
      <div className="mt-3 space-y-3">{skillCategories.map(([name, entries], index) => <div className="rounded-2xl border border-line bg-soft p-3" key={index}>
        <div className="flex items-center gap-2">
          <input className="field !mb-0 font-semibold" placeholder="Category (e.g. Languages)" value={name} onChange={(e) => renameCategory(index, e.target.value)} />
          <button className="btn-secondary !px-3 text-red-600" aria-label="Remove category" onClick={() => removeCategory(index)}><Trash2 size={15} /></button>
        </div>
        <SkillEntriesInput entries={entries} onCommit={(next) => editCategoryEntries(index, next)} />
      </div>)}</div>
    </>}
  </>;

  const renderEducation = () => <>
    <div className="space-y-3">{profile.education.map((entry) => <div className="rounded-2xl border border-line bg-soft p-3" key={entry.id}>
      <div className="grid gap-3 sm:grid-cols-2">
        <input className="field" placeholder="School *" value={entry.school} onChange={(e) => updateEducation(entry.id, { school: e.target.value })} />
        <input className="field" placeholder="Location (e.g. Cambridge, MA)" value={entry.location} onChange={(e) => updateEducation(entry.id, { location: e.target.value })} />
        <input className="field" placeholder="Degree & concentration" value={entry.degree} onChange={(e) => updateEducation(entry.id, { degree: e.target.value })} />
        <input className="field" placeholder="Graduation date (e.g. May 2024)" value={entry.graduationDate} onChange={(e) => updateEducation(entry.id, { graduationDate: e.target.value })} />
        <input className="field" placeholder="GPA (optional)" value={entry.gpa} onChange={(e) => updateEducation(entry.id, { gpa: e.target.value })} />
        <input className="field" placeholder="Honors / distinctions (optional)" value={entry.honors} onChange={(e) => updateEducation(entry.id, { honors: e.target.value })} />
      </div>
      <textarea className="field mt-3 min-h-20" placeholder="Relevant coursework — one per line (optional)" value={entry.coursework.join("\n")} onChange={(e) => updateEducation(entry.id, { coursework: e.target.value.split("\n") })} />
      <div className="mt-3 flex justify-end"><button className="btn-secondary !px-3 text-red-600" onClick={() => removeEducation(entry.id)}><Trash2 size={15} /> Remove</button></div>
    </div>)}</div>
    <button className="mt-3 btn-secondary" onClick={addEducation}><Plus size={16} /> {profile.education.length ? "Add another" : "Add your education"}</button>
  </>;

  const renderExtras = () => <>
    <label className="block"><span className="label">Certifications</span><textarea className="field min-h-28" placeholder="AWS Certified Solutions Architect, 2023" value={profile.certifications.join("\n")} onChange={(e) => setProfile({ ...profile, certifications: e.target.value.split("\n").filter(Boolean) })} /><span className="mt-1 block text-xs text-muted">One per line.</span></label>
    <div className="mt-5 flex items-center justify-between"><span className="label !mb-0">Languages</span><button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={addLanguage}><Plus size={15} /> Language</button></div>
    <div className="mt-3 space-y-3">{profile.languages.map((language, index) => <div className="flex items-center gap-3" key={index}>
      <input className="field" placeholder="Language (e.g. Spanish)" value={language.language} onChange={(e) => updateLanguage(index, { language: e.target.value })} />
      <input className="field" placeholder="Native / Fluent / B2" value={language.level} onChange={(e) => updateLanguage(index, { level: e.target.value })} />
      <button className="btn-secondary !px-3 text-red-600" onClick={() => removeLanguage(index)}><Trash2 size={15} /></button>
    </div>)}</div>
    {!profile.languages.length && <button className="mt-3 btn-secondary" onClick={addLanguage}><Plus size={16} /> Add a language</button>}
  </>;

  const sectionBody = (id: ProfileSectionId) => id === "basics" ? renderBasics() : id === "experience" ? renderExperience() : id === "skills" ? renderSkills() : id === "education" ? renderEducation() : renderExtras();

  // The pre-parse upload screen. Its own narrow card with the staged loader.
  if (view === "source") return <Shell title="Build your base CV" eyebrow="Set up once, tailor to any job">
    <div className="card mx-auto max-w-2xl">
      {error && <div className="mb-4"><ErrorBox message={error} /></div>}
      <h2 className="section-title">Start with your real CV</h2>
      <p className="mt-2 text-sm text-muted">Upload a PDF or DOCX and we'll pull out your experience automatically. It's sent securely to AI — we never store the file.</p>
      {busy ? <div className="mt-6"><StagedLoader stages={["Reading your CV", "Pulling out your experience", "Organizing your skills"]} /></div> : <>
        <label className="onboarding-dropzone mt-5"><Upload size={22} /><span className="font-semibold">Upload PDF or DOCX</span><span className="text-xs text-muted">or drag &amp; drop a file</span><input type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) runUpload(f); }} /></label>
        <div className="my-4 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" /> or paste the text <span className="h-px flex-1 bg-line" /></div>
        <textarea className="field min-h-48" placeholder="Paste your CV text here…" value={rawText} onChange={(e) => setRawText(e.target.value)} />
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{rawText.trim().length < 30 ? "Add a bit more text to continue" : "Looks good — ready to structure"}</span>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setView("basics")}>Enter details manually</button>
            <button className="btn-primary" disabled={rawText.trim().length < 30} onClick={structure}><Sparkles size={16} /> Structure with AI</button>
          </div>
        </div>
      </>}
    </div>
  </Shell>;

  const inManualStep = MANUAL_STEPS.includes(view);
  const stepIndex = MANUAL_FLOW.indexOf(view);

  return <Shell title="Build your base CV" eyebrow="Set up once, tailor to any job">
    {inManualStep && <div className="mx-auto mb-6 max-w-3xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">{SECTION_META[view as ProfileSectionId].title}</span>
        <span className="text-xs font-semibold text-muted">Step {stepIndex + 1} of {MANUAL_FLOW.length} · {pctComplete}% there</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-emerald transition-all duration-300" style={{ width: `${((stepIndex + 1) / MANUAL_FLOW.length) * 100}%` }} />
      </div>
    </div>}

    <div className="card mx-auto max-w-3xl">
      {error && <div className="mb-4"><ErrorBox message={error} /></div>}

      {view === "summary" && <>
        <h2 className="section-title">Here's what we found</h2>
        <p className="mt-2 text-sm text-muted">We pulled your details into a base CV. Sections marked <span className="font-semibold text-amber-600">Needs a look</span> are worth a quick check — the rest is ready to go.</p>
        <div className="mt-5 space-y-3">{sections.map((s, i) => {
          const open = expanded.has(s.id);
          return <div key={s.id} className="status-card onboarding-rise" style={{ animationDelay: `${i * 50}ms` }}>
            <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => toggleExpanded(s.id)}>
              {s.complete
                ? <span className="status-chip status-chip-ok"><Check size={13} strokeWidth={3} /> Looks complete</span>
                : <span className="status-chip status-chip-warn"><AlertTriangle size={13} /> Needs a look</span>}
              <span className="min-w-0 flex-1"><span className="font-semibold text-ink">{s.label}</span><span className="block truncate text-xs text-muted">{s.complete ? s.summary : s.reason}</span></span>
              <ChevronDown size={18} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && <div className="mt-4 border-t border-line pt-4">{sectionBody(s.id)}</div>}
          </div>;
        })}</div>
      </>}

      {inManualStep && <>
        <h2 className="section-title">{SECTION_META[view as ProfileSectionId].title}</h2>
        <p className="mt-2 mb-5 text-sm text-muted">{SECTION_META[view as ProfileSectionId].blurb}</p>
        {sectionBody(view as ProfileSectionId)}
      </>}

      {view === "review" && <>
        <h2 className="section-title">Last look</h2>
        <p className="mt-2 text-sm text-muted">Edit anything inline, then finish. You can keep refining everything later in the editor.</p>
        <div className="your-resume-canvas mt-5 overflow-x-auto rounded-2xl border border-line bg-soft p-3 sm:p-6">
          <CvDocument cv={profile} editable headline={profile.targetRole}
            onChange={(next) => setProfile({
              ...profile,
              ...next,
              experiences: next.experiences.map((experience) => ({
                ...experience,
                bullets: experience.bullets.map((bullet) => typeof bullet === "string" ? bullet : bullet.text)
              }))
            })}
            onCommitHeadline={(value) => setProfile({ ...profile, targetRole: value })} />
        </div>
      </>}

      {/* Footer navigation, per view */}
      {view === "summary" && <div className="mt-6 flex items-center justify-between gap-2">
        <button className="btn-secondary" onClick={() => setView("source")}><ArrowLeft size={16} /> Re-upload</button>
        <button className="btn-primary" onClick={() => setView("review")}>{incomplete.length ? `Continue — ${incomplete.length} to double-check` : "Looks great — continue"} <ArrowRight size={16} /></button>
      </div>}

      {inManualStep && <div className="mt-6 flex items-center justify-between gap-2">
        {stepIndex > 0 ? <button className="btn-secondary" onClick={() => setView(MANUAL_FLOW[stepIndex - 1] ?? "basics")}><ArrowLeft size={16} /> Back</button> : <span />}
        <div className="flex gap-2">
          {basicsValid && <button className="btn-secondary" onClick={finish}><Check size={16} /> Finish setup</button>}
          <button className="btn-primary" onClick={() => setView(MANUAL_FLOW[stepIndex + 1] ?? "review")}>Continue <ArrowRight size={16} /></button>
        </div>
      </div>}

      {view === "review" && <div className="mt-6 flex items-center justify-between gap-2">
        <button className="btn-secondary" onClick={() => setView(rawText.trim().length >= 30 ? "summary" : "extras")}><ArrowLeft size={16} /> Back</button>
        <button className="btn-primary" onClick={finish}><Check size={16} /> Finish setup</button>
      </div>}
    </div>
  </Shell>;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  if (globalThis.chrome?.downloads) chrome.downloads.download({ url, filename: fileName, saveAs: true });
  else { const a = document.createElement("a"); a.href = url; a.download = fileName; a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// Sticky editor toolbar: Edit/Preview toggle, live page-count badge, style menu
// and download menu. Replaces the scattered sidebar style + download cards.
function EditorToolbar({ mode, onMode, pages, style, onStyle, onExport, busy }: {
  mode: "edit" | "preview";
  onMode: (mode: "edit" | "preview") => void;
  pages: number;
  style?: CvStyle;
  onStyle: (style: CvStyle) => void;
  onExport: (format: "pdf" | "docx") => void;
  busy?: boolean;
}) {
  return (
    <div className="editor-toolbar">
      <div className="seg" role="tablist" aria-label="Editor mode">
        <button type="button" role="tab" aria-selected={mode === "edit"} className={mode === "edit" ? "is-on" : ""} onClick={() => onMode("edit")}>
          <PenLine size={14} /> Edit
        </button>
        <button type="button" role="tab" aria-selected={mode === "preview"} className={mode === "preview" ? "is-on" : ""} onClick={() => onMode("preview")}>
          <Eye size={14} /> Preview
        </button>
      </div>
      <span className={`page-badge ${pages <= 1 ? "is-ok" : "is-warn"}`} title="Estimated pages in the exported file">
        {pages <= 1 ? <><Check size={13} /> Fits on 1 page</> : <><Files size={13} /> {pages} pages</>}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <StyleMenu value={style} onChange={onStyle} />
        <DownloadMenu onExport={onExport} busy={busy} />
      </div>
    </div>
  );
}

// Lightweight popover closed by an invisible full-screen backdrop — reliable in
// the extension without wiring document-level click-outside listeners.
function StyleMenu({ value, onChange }: { value?: CvStyle; onChange: (style: CvStyle) => void }) {
  const [open, setOpen] = useState(false);
  const preset = cvStyleSchema.parse(value ?? {}).preset;
  const current = STYLE_PRESETS.find((p) => p.id === preset) ?? STYLE_PRESETS[0]!;
  return (
    <div className="menu">
      <button type="button" className="toolbar-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Palette size={15} /> {current.label} <ChevronDown size={14} className="text-muted" />
      </button>
      {open && <>
        <button type="button" className="menu-backdrop" aria-hidden onClick={() => setOpen(false)} tabIndex={-1} />
        <div className="menu-pop" role="menu">
          {STYLE_PRESETS.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === preset}
              className={`menu-item ${p.id === preset ? "is-on" : ""}`} onClick={() => { onChange({ preset: p.id }); setOpen(false); }}>
              <span className="style-swatch" style={resumeStyleVars({ preset: p.id }) as React.CSSProperties}>Aa</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">{p.label}</span>
                <span className="block text-xs text-muted">{p.hint}</span>
              </span>
              {p.id === preset && <Check size={15} className="shrink-0 text-emerald" />}
            </button>
          ))}
        </div>
      </>}
    </div>
  );
}

function DownloadMenu({ onExport, busy }: { onExport: (format: "pdf" | "docx") => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu">
      <button type="button" className="toolbar-btn is-primary" disabled={!!busy} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Download size={15} /> Download <ChevronDown size={14} />
      </button>
      {open && <>
        <button type="button" className="menu-backdrop" aria-hidden onClick={() => setOpen(false)} tabIndex={-1} />
        <div className="menu-pop is-right" role="menu">
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onExport("pdf"); setOpen(false); }}><FileText size={15} className="text-emerald" /> PDF</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onExport("docx"); setOpen(false); }}><FileText size={15} className="text-emerald" /> DOCX</button>
        </div>
      </>}
    </div>
  );
}

const STYLE_PRESETS: Array<{ id: CvStyle["preset"]; label: string; hint: string }> = [
  { id: "modern", label: "Modern", hint: "Sans-serif · emerald accent" },
  { id: "garamond", label: "Garamond", hint: "Serif · monochrome" },
  { id: "times", label: "Times", hint: "Serif · monochrome" }
];

// Per-resume style preset. Edits the `style` object on the CV/profile, which
// drives both the live canvas and the PDF/DOCX export. Shared by the tailored-CV
// editor and the base-resume editor.
function StylePanel({ value, onChange }: { value?: CvStyle; onChange: (style: CvStyle) => void }) {
  const preset = cvStyleSchema.parse(value ?? {}).preset;
  return (
    <div className="card">
      <p className="flex items-center gap-2 text-sm font-semibold"><Palette size={15} /> Style</p>
      <p className="mt-1 text-xs text-muted">Applies to the preview and your PDF/DOCX downloads.</p>
      <div className="mt-3 space-y-1.5">
        {STYLE_PRESETS.map((p) => (
          <button key={p.id} onClick={() => onChange({ preset: p.id })}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${preset === p.id ? "border-emerald bg-mint/50" : "border-line hover:border-emerald/50"}`}>
            <span>
              <span className="block text-sm font-semibold text-ink">{p.label}</span>
              <span className="block text-xs text-muted">{p.hint}</span>
            </span>
            {preset === p.id && <Check size={16} className="shrink-0 text-emerald" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function Editor({ state, cvId, onChange }: { state: StorageState; cvId: string; onChange: (s: StorageState) => void }) {
  const [cv, setCv] = useState(state.drafts[cvId]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [pages, setPages] = useState(1);
  const { saveState, markEdited } = useSaveStatus();
  useEffect(() => { if (!cv) return; const timer = setTimeout(async () => {
    const next = await updateState((s) => ({ ...s, drafts: { ...s.drafts, [cv.id]: { ...cv, updatedAt: new Date().toISOString() } }, applications: s.applications.map((a) => a.tailoredCv.id === cv.id ? { ...a, tailoredCv: cv, updatedAt: new Date().toISOString() } : a) }));
    onChange(next); markEdited.saved();
  }, 500); return () => clearTimeout(timer); }, [cv]);
  if (!cv || !state.profile) return <Shell title="CV not found"><ErrorBox message="This tailored CV is no longer in local storage." /></Shell>;
  const currentCv = cv;

  async function regenerate(section: "summary" | "experience" | "skills", experienceId?: string) {
    setBusy(`Regenerating ${section}…`); setError("");
    try {
      const result = await api.regenerate(state.settings.apiBaseUrl, state.settings.aiProvider, { profile: state.profile!, cv: currentCv, section, experienceId });
      // Merge only the regenerated section into the LATEST edits (functional
      // update), so inline edits made to other sections while the request was in
      // flight aren't clobbered by the pre-edit snapshot the result was built on.
      setCv((prev) => (prev ? applyRegeneratedSection(prev, result, section, experienceId) : currentCv));
    }
    catch (e) { if (!(await handleAuthExpiry(e, onChange))) setError((e as Error).message); } finally { setBusy(""); }
  }
  async function exportCv(format: "pdf" | "docx") {
    setBusy(`Creating ${format.toUpperCase()}…`); setError("");
    try { downloadBlob(await api.export(state.settings.apiBaseUrl, state.settings.aiProvider, state.profile!, currentCv, format), `${currentCv.job.company || "tailored"}-${currentCv.job.title || "cv"}.${format}`); }
    catch (e) { if (!(await handleAuthExpiry(e, onChange))) setError((e as Error).message); } finally { setBusy(""); }
  }

  // Fresh-grad nudge: with little to no work history, education usually belongs
  // first. Suggest it when experience is thin and education currently sits below.
  const order = effectiveSectionOrder(currentCv.sectionOrder);
  const thinExperience = currentCv.experiences.filter((e) => e.role || e.bullets.some(Boolean)).length <= 1;
  const showEducationNudge = thinExperience && currentCv.education.some(educationHasContent)
    && order.indexOf("education") > order.indexOf("experience") && !nudgeDismissed;
  function leadWithEducation() {
    const next: string[] = order.filter((id) => id !== "education");
    next.splice(next.indexOf("experience"), 0, "education");
    setCv({ ...currentCv, sectionOrder: next }); markEdited.editing(); setNudgeDismissed(true);
  }

  return <Shell title={`${cv.job.title || "Tailored CV"} · ${cv.job.company || "Job"}`}>
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
      <div className="space-y-4">
        {error && <ErrorBox message={error} />}
        {busy && <div className="card"><Loading label={busy} /></div>}
        {!cv.evaluation && !!cv.unsupportedClaims.length && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4"><div className="flex gap-2 font-semibold text-amber-900"><AlertTriangle size={18} /> Review possible unsupported claims</div>{cv.unsupportedClaims.map((claim) => <p className="mt-2 text-sm text-amber-900" key={claim.text}><strong>{claim.section}:</strong> {claim.text} — {claim.reason}</p>)}</div>}
        <FirstEditHint state={state} onChange={onChange} />
        <EditorToolbar mode={mode} onMode={setMode} pages={pages} style={currentCv.style}
          onStyle={(style) => { setCv({ ...currentCv, style }); markEdited.editing(); }} onExport={exportCv} busy={!!busy} />
        <div className={`tailored-resume-canvas rounded-2xl p-3 sm:p-6 ${mode === "preview" ? "is-preview bg-soft" : "bg-soft ring-1 ring-line"}`}>
          {mode === "edit" && <CvDocument cv={cv} editable lockExperienceFacts onChange={(next) => {
            let updated = next as TailoredCv;
            if (updated.summary !== currentCv.summary) updated = markTailoredTextStale(updated, "summary");
            if (JSON.stringify(updated.skills) !== JSON.stringify(currentCv.skills) || JSON.stringify(updated.skillCategories) !== JSON.stringify(currentCv.skillCategories)) {
              updated = markTailoredTextStale(updated, "skills");
            }
            for (const experience of updated.experiences) {
              const previous = currentCv.experiences.find((item) => item.id === experience.id);
              if (previous && (
                experience.role !== previous.role ||
                experience.company !== previous.company ||
                experience.startDate !== previous.startDate ||
                experience.endDate !== previous.endDate ||
                JSON.stringify(experience.bullets) !== JSON.stringify(previous.bullets)
              )) {
                updated = markTailoredTextStale(updated, "experience", experience.id);
              }
            }
            setCv(updated); markEdited.editing();
          }} onCommitHeadline={(v) => { setCv({ ...currentCv, job: { ...currentCv.job, title: v }, readiness: "blocked" }); markEdited.editing(); }} onRegenerate={regenerate} busy={!!busy} />}
          {/* Always mounted: drives the live page badge in edit mode and the A4
              sheets in preview mode from one faithful read-only measurement. */}
          <PaginatedPreview cv={currentCv} headline={currentCv.job?.title} showSheets={mode === "preview"} onPageCount={setPages} />
        </div>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        {mode === "edit" && <InlineEditHint saveState={saveState}>Click any line in the resume to rewrite it. Hover a section heading to <span className="font-semibold text-emerald">Regenerate</span> or reorder with the ▲▼ arrows. Switch to <span className="font-semibold text-emerald">Preview</span> to see exact pages.</InlineEditHint>}
        <QualitySignals cv={currentCv} />
        {showEducationNudge && (
          <div className="rounded-2xl border border-emerald bg-mint/40 p-4">
            <p className="text-sm font-semibold text-deep">Lead with Education?</p>
            <p className="mt-1 text-xs text-muted">With limited work history, recruiters expect Education near the top. Move it above Experience?</p>
            <div className="mt-3 flex gap-2">
              <button className="btn-primary !px-3 !py-1.5 text-sm" onClick={leadWithEducation}><ArrowRight size={14} /> Move it up</button>
              <button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={() => setNudgeDismissed(true)}>Dismiss</button>
            </div>
          </div>
        )}
        <p className="px-1 text-[11px] text-muted">Downloads (top right) receive one final format check before export.</p>
        <button className="btn-secondary w-full" onClick={() => { location.hash = "#applications"; }}><ArrowLeft size={16} /> Back to applications</button>
      </aside>
    </div>
  </Shell>;
}

// Friendly labels for the persisted tailoring-run stage, mirroring the wording
// used in the popup so the in-progress hero reads consistently.
const TAILORING_STAGE_LABELS: Record<string, string> = {
  queued: "Queued…",
  planning: "Planning evidence…",
  writing: "Writing your CV…",
  validating: "Checking factual support…",
  critic: "Reviewing quality…",
  repairing: "Repairing flagged content…",
  completed: "Finishing up…"
};

// Compact "2 hours ago" / "3 days ago" style relative time for activity dates,
// falling back to an absolute date for anything older than a week.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

// Visual treatment for each application lifecycle status, used by the status
// badge/dropdown in the home table.
const STATUS_META: Record<ApplicationStatus, { label: string; cls: string; dot: string }> = {
  "not-sent": { label: "Not sent", cls: "bg-soft text-muted ring-1 ring-line", dot: "bg-slate-400" },
  sent: { label: "Sent", cls: "bg-mint text-deep", dot: "bg-deep" },
  replied: { label: "Replied", cls: "bg-emerald text-white", dot: "bg-white" }
};
const STATUS_ORDER: ApplicationStatus[] = ["not-sent", "sent", "replied"];

// Stable per-company tint for the row monogram tile, so a long list reads as a
// varied-but-controlled palette instead of a wall of identical green.
const MONO_TINTS = [
  "bg-emerald/15 text-deep", "bg-sky-100 text-sky-700", "bg-amber-100 text-amber-800",
  "bg-violet-100 text-violet-700", "bg-rose-100 text-rose-700", "bg-teal-100 text-teal-800"
];
function monoTint(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return MONO_TINTS[h % MONO_TINTS.length];
}
function monoInitials(title: string, company: string) {
  const src = (company || title || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const raw = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : src.slice(0, 2);
  return (raw || "?").toUpperCase();
}

// A band label for how complete/strong a tailored CV reads, reusing the same
// completeness engine as the sidebar so the table and editor agree.
function strengthBand(cv: TailoredCv): string {
  const { score } = evaluateResume(cv, "tailored", []);
  return score >= 85 ? "Strong" : score >= 60 ? "Good" : "Needs work";
}

// Minimal click-away dropdown. The trigger is a styled button; `children` is a
// render prop receiving a `close` callback so items can dismiss the menu.
function Menu({ label, className, align = "right", children }: {
  label: React.ReactNode;
  className?: string;
  align?: "left" | "right";
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <div className="relative inline-block">
    <button type="button" className={className} onClick={() => setOpen((o) => !o)}>{label}</button>
    {open && <>
      <button type="button" tabIndex={-1} aria-hidden className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
      <div className={`absolute z-30 mt-1 min-w-44 rounded-xl border border-line bg-white p-1 text-left shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
        {children(() => setOpen(false))}
      </div>
    </>}
  </div>;
}

const MENU_ITEM = "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm hover:bg-soft";

// First name for the personal greeting. Prefers the signed-in account name, then
// the base-profile contact name, then a friendly fallback so Home never greets a
// blank.
function firstName(state: StorageState): string {
  const full = (state.auth?.name || state.profile?.contact?.name || "").trim();
  return full ? full.split(/\s+/)[0]! : "there";
}

// Time-of-day greeting, evaluated once per render. Kept tiny so it reads cleanly
// in the hero alongside the name.
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Home({ state, onChange: _onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [usage, setUsage] = useState<{ total: number; byAction: Record<string, number> } | null>(null);
  useEffect(() => {
    api.usage(state.settings.apiBaseUrl, state.settings.aiProvider).then(setUsage).catch(() => setUsage(null));
  }, []);

  const recent = useMemo(() => [...state.applications]
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)), [state.applications]);

  // Base-resume health: reuse the same engine the sidebar uses, but only surface
  // it on Home when there are still outstanding suggestions.
  const health = useMemo(
    () => (state.profile ? evaluateResume(state.profile, "base", state.profile.dismissedChecks ?? []) : null),
    [state.profile]
  );
  const topCheck = health?.checks[0];

  const job = state.tailoringJob;
  const activeRun = job && (job.status === "running" || job.status === "error") ? job : null;
  // When no run is mid-flight, the most-recently-touched application becomes the
  // "continue editing" hero. It's then excluded from the recent list so it isn't
  // shown twice.
  const continueRecord = !activeRun ? recent[0] : undefined;
  const listRecords = (continueRecord ? recent.slice(1) : recent).slice(0, 3);

  const tailoredThisMonth = usage?.byAction.tailor ?? 0;
  const sentCount = state.applications.filter((a) => a.status !== "not-sent").length;
  const repliedCount = state.applications.filter((a) => a.status === "replied").length;
  const hasApps = state.applications.length > 0;

  const subline = !state.profile ? "Let's set up your base resume to get started."
    : activeRun?.status === "running" ? "We're tailoring your resume right now."
    : hasApps ? `${tailoredThisMonth} tailored this month — keep the momentum going.`
    : "Open a job post and tailor your first resume.";

  return <Shell title={`${greeting()}, ${firstName(state)} 👋`} eyebrow="Your launchpad">
    <p className="home-rise -mt-3 mb-6 text-muted">{subline}</p>

    {/* Smart primary action — one state-aware hero card. */}
    <div className="home-rise mb-6">{
      activeRun?.status === "running"
      ? <div className="card border-emerald bg-mint/30 !p-6">
          <p className="text-xs font-semibold uppercase tracking-[.1em] text-emerald">Tailoring in progress</p>
          <div className="mt-1 flex items-center gap-2"><LoaderCircle size={20} className="animate-spin text-deep" /><h2 className="font-display text-xl font-bold text-deep">{TAILORING_STAGE_LABELS[activeRun.stage] || "Working on your CV…"}</h2></div>
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/70"><div className="h-full rounded-full bg-emerald transition-all" style={{ width: `${Math.max(5, activeRun.progress)}%` }} /></div>
          {!!activeRun.cvId && <button className="btn-secondary mt-5 !bg-white" onClick={() => { location.hash = `#editor/${activeRun.cvId}`; }}><FilePenLine size={15} /> Open draft</button>}
        </div>
      : activeRun?.status === "error"
      ? <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-950">
          <div className="flex gap-2 font-semibold"><AlertTriangle size={18} /> Last tailoring didn't finish</div>
          <p className="mt-1 text-sm">{activeRun.error || "Something interrupted the last run. Reopen the job from the extension to try again."}</p>
          {!!activeRun.cvId && <button className="btn-secondary mt-4 !bg-white" onClick={() => { location.hash = `#editor/${activeRun.cvId}`; }}><FilePenLine size={15} /> Open last draft</button>}
        </div>
      : !state.profile
      ? <div className="card flex flex-col gap-4 border-emerald bg-mint/30 !p-6 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="font-display text-xl font-bold text-deep">Create your base resume</p><p className="mt-1 text-sm text-muted">Set it up once, then tailor it to any job in a couple of clicks.</p></div>
          <button className="btn-primary shrink-0" onClick={() => location.hash = "#onboarding"}><Sparkles size={16} /> Get started</button>
        </div>
      : continueRecord
      ? <div className="card flex flex-col gap-4 border-emerald bg-mint/30 !p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[.1em] text-emerald">Pick up where you left off</p>
            <h2 className="mt-1 truncate font-display text-xl font-bold">{continueRecord.job.title || "Untitled job"}</h2>
            <p className="text-sm text-muted">{continueRecord.job.company || "Unknown company"} · edited {relativeTime(continueRecord.updatedAt || continueRecord.createdAt)}</p>
          </div>
          <button className="btn-primary shrink-0" onClick={() => { location.hash = `#editor/${continueRecord.tailoredCv.id}`; }}><FilePenLine size={16} /> Continue editing</button>
        </div>
      : <div className="card flex flex-col gap-4 border-emerald bg-mint/30 !p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald"><MousePointerClick size={18} /></span>
            <div><p className="font-display text-xl font-bold text-deep">Tailor your next application</p><p className="mt-1 text-sm text-muted">Click the Fyxor icon on any job post, then send the offer here. LinkedIn jobs are detected automatically.</p></div>
          </div>
        </div>
    }</div>

    {/* At-a-glance summary — numbers only; management lives in Applications. */}
    {hasApps && <div className="home-rise mb-6 grid gap-4 sm:grid-cols-3">
      <div className="card">
        <div className="flex items-center gap-2 text-sm text-muted"><Sparkles size={15} className="text-emerald" /> Tailored this month</div>
        <p className="mt-2 font-display text-3xl font-bold">{tailoredThisMonth}</p>
        <p className="mt-1 text-xs text-muted">{state.applications.length} total in your tracker</p>
      </div>
      <div className="card">
        <div className="flex items-center gap-2 text-sm text-muted"><Send size={15} className="text-emerald" /> Sent</div>
        <p className="mt-2 font-display text-3xl font-bold">{sentCount}</p>
        <p className="mt-1 text-xs text-muted">of {state.applications.length} tailored</p>
      </div>
      <div className="card">
        <div className="flex items-center gap-2 text-sm text-muted"><Reply size={15} className="text-emerald" /> Replied</div>
        <p className="mt-2 font-display text-3xl font-bold">{repliedCount}</p>
        <p className="mt-1 text-xs text-muted">{sentCount ? `${Math.round((repliedCount / sentCount) * 100)}% of sent` : "no replies yet"}</p>
      </div>
    </div>}

    {/* Slim base-resume nudge — a pointer into Your Resume, not a duplicate of it. */}
    {health && topCheck && <button onClick={() => { location.hash = "#resume"; }} className="home-rise mb-6 flex w-full items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-left text-amber-950 transition hover:bg-amber-100">
      <Lightbulb size={18} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">Your base resume could be stronger — {topCheck.label}</span>
      <span className="shrink-0 rounded-full bg-white px-2.5 py-0.5 text-sm font-bold">{health.score}/100</span>
      <ArrowRight size={16} className="shrink-0" />
    </button>}

    {/* Recent activity — a read-only peek that links into Applications. */}
    {hasApps && <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-title">Recent activity</h2>
        <button className="inline-flex items-center gap-1 text-sm font-semibold text-emerald hover:text-deep" onClick={() => location.hash = "#applications"}>View all in Applications <ArrowRight size={14} /></button>
      </div>
      {!listRecords.length ? <EmptyApplications /> :
      <div className="home-rise card !p-0">
        {listRecords.map((record) => (
          <button key={record.id} onClick={() => { location.hash = `#editor/${record.tailoredCv.id}`; }}
            className="tracker-row flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition last:border-0 hover:bg-soft/40">
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold ${monoTint(record.job.company || record.job.title || record.id)}`}>{monoInitials(record.job.title, record.job.company)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{record.job.title || "Untitled job"}{record.job.company ? <span className="font-normal text-muted"> at {record.job.company}</span> : ""}</span>
              <span className="mt-0.5 block text-xs text-muted">{relativeTime(record.updatedAt || record.createdAt)} · {strengthBand(record.tailoredCv)}</span>
            </span>
            <ArrowRight size={16} className="shrink-0 text-muted" />
          </button>
        ))}
      </div>}
    </>}
  </Shell>;
}

function ResumeView({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [profile, setProfile] = useState(state.profile);
  const { saveState, markEdited } = useSaveStatus();
  useEffect(() => { if (!profile) return; const timer = setTimeout(async () => {
    const next = await updateState((s) => ({ ...s, profile: { ...profile, updatedAt: new Date().toISOString() } }));
    onChange(next); markEdited.saved();
  }, 500); return () => clearTimeout(timer); }, [profile]);

  if (!profile) return <Shell title="Your resume">
    <div className="card py-16 text-center"><FileText className="mx-auto text-emerald" size={32} /><h2 className="mt-4 section-title">You don't have a resume yet</h2><p className="mx-auto mt-2 max-w-md text-sm text-muted">Create your base CV once — upload a file or build it step by step. It becomes the source for every tailored application.</p><button className="btn-primary mt-6" onClick={() => location.hash = "#onboarding"}><Sparkles size={16} /> Create your resume</button></div>
  </Shell>;

  const evidenceGaps = missingStructuredProfileEvidence(profile);
  return <Shell title="Your resume">
    {!!evidenceGaps.length && <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <div className="flex gap-2 font-semibold"><AlertTriangle size={18} /> Some source details need a quick profile update</div>
      <p className="mt-1 text-sm">Your original CV appears to mention {evidenceGaps.join(" and ")}, but those fields are empty in the structured profile. Add them once so every tailored resume can preserve them.</p>
      <button className="btn-secondary mt-3 !bg-white" onClick={() => { location.hash = "#onboarding/evidence"; }}>Update certifications and languages</button>
    </div>}
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
      <div>
        <FirstEditHint state={state} onChange={onChange} />
        <div className="your-resume-canvas rounded-2xl bg-soft p-3 ring-1 ring-line sm:p-6"><CvDocument cv={profile} headline={profile.targetRole} editable onChange={(next) => { setProfile({ ...profile, ...(next as Partial<BaseProfile>) }); markEdited.editing(); }} onCommitHeadline={(v) => { setProfile({ ...profile, targetRole: v.trim() }); markEdited.editing(); }} /></div>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <InlineEditHint saveState={saveState}>Click any line to rewrite it. Changes save to your base resume.</InlineEditHint>
        <StrengthPanel state={state} doc={profile} kind="base" onChange={onChange}
          onDismiss={(id) => { setProfile({ ...profile, dismissedChecks: [...(profile.dismissedChecks ?? []), id] }); markEdited.editing(); }} />
        <StylePanel value={profile.style} onChange={(style) => { setProfile({ ...profile, style }); markEdited.editing(); }} />
        <button className="btn-secondary w-full" onClick={() => location.hash = "#onboarding"}><PenLine size={16} /> Redo step-by-step setup</button>
      </aside>
    </div>
  </Shell>;
}

const TRACKER_FILTERS: { key: "all" | ApplicationStatus; label: string }[] = [
  { key: "all", label: "All" }, { key: "not-sent", label: "Not sent" },
  { key: "sent", label: "Sent" }, { key: "replied", label: "Replied" }
];

function Tracker({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [confirmingId, setConfirmingId] = useState("");
  const [filter, setFilter] = useState<"all" | ApplicationStatus>("all");
  const [toast, setToast] = useState<{ label: string; cls: string; dot: string; key: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Most-recently-touched first, matching the ordering Home uses for its table.
  const records = useMemo(() => [...state.applications]
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)), [state.applications]);
  const counts = useMemo(() => ({
    all: records.length,
    "not-sent": records.filter((r) => r.status === "not-sent").length,
    sent: records.filter((r) => r.status === "sent").length,
    replied: records.filter((r) => r.status === "replied").length
  }), [records]);
  const visible = filter === "all" ? records : records.filter((r) => r.status === filter);

  // Status changes are a deliberate user action, not an edit — keep updatedAt
  // untouched so "last edited" / continue-editing stays meaningful.
  async function setStatus(id: string, status: ApplicationStatus) {
    onChange(await updateState((s) => ({ ...s, applications: s.applications.map((a) => (a.id === id ? { ...a, status } : a)) })));
    const meta = STATUS_META[status];
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ ...meta, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }
  async function duplicate(record: ApplicationRecord) {
    const cv = { ...record.tailoredCv, id: makeId("cv"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const copy = { ...record, id: makeId("application"), tailoredCv: cv, status: "not-sent" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    onChange(await updateState((s) => ({ ...s, drafts: { ...s.drafts, [cv.id]: cv }, applications: [copy, ...s.applications] })));
  }
  async function remove(id: string) {
    setConfirmingId("");
    onChange(await updateState((s) => {
      const removed = s.applications.find((a) => a.id === id);
      // Also drop the orphaned draft so deleted CVs don't accumulate in storage
      // (and get pushed to the cloud) forever. Drafts aren't shared between
      // records, so the draft id is safe to remove with its application.
      const drafts = { ...s.drafts };
      if (removed) delete drafts[removed.tailoredCv.id];
      return { ...s, drafts, applications: s.applications.filter((a) => a.id !== id) };
    }));
  }
  async function exportRecord(record: ApplicationRecord, format: "pdf" | "docx") {
    if (!state.profile) return;
    try { downloadBlob(await api.export(state.settings.apiBaseUrl, state.settings.aiProvider, state.profile, record.tailoredCv, format), `${record.job.company || "tailored"}-${record.job.title || "cv"}.${format}`); }
    catch (e) { await handleAuthExpiry(e, onChange); }
  }

  return <Shell title="Applications" eyebrow="Track every role you've tailored for">
    {!state.settings.onboardingComplete && <div className="mb-5 card flex items-center justify-between"><div><p className="font-semibold">Complete your base profile</p><p className="text-sm text-muted">Tailoring needs verified source experience.</p></div><button className="btn-primary" onClick={() => location.hash = "#onboarding"}>Start onboarding</button></div>}
    {!records.length ? <EmptyApplications /> : <>
      <div className="card overflow-hidden !p-0">
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-2.5 sm:px-4">
          {TRACKER_FILTERS.map(({ key, label }) => {
            const on = filter === key;
            return <button key={key} onClick={() => setFilter(key)} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold transition ${on ? "bg-deep text-white" : "text-muted hover:bg-soft hover:text-ink"}`}>
              {label}<span className={`rounded-full px-1.5 text-xs font-bold tabular-nums ${on ? "bg-white/20" : "bg-soft text-muted"}`}>{counts[key]}</span>
            </button>;
          })}
        </div>

        {!visible.length ? <div className="px-5 py-14 text-center text-sm text-muted">No applications with this status yet.</div> :
        visible.map((record) => {
          const meta = STATUS_META[record.status];
          return <div key={record.id} className="tracker-row flex flex-col gap-3 border-b border-line px-4 py-4 transition last:border-0 hover:bg-soft/50 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
            <button className="min-w-0 flex-1 text-left" onClick={() => { location.hash = `#editor/${record.tailoredCv.id}`; }}>
              <span className="block truncate font-semibold">{record.job.title || "Untitled job"}{record.job.company ? <span className="font-normal text-muted"> · {record.job.company}</span> : ""}</span>
              <span className="mt-0.5 block truncate text-xs text-muted">{relativeTime(record.updatedAt || record.createdAt)} · {strengthBand(record.tailoredCv)}</span>
            </button>
            <div className="shrink-0 sm:w-28">
              <Menu align="left" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.cls}`} label={<><span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />{meta.label}<ChevronDown size={12} /></>}>
                {(close) => STATUS_ORDER.map((s) => <button key={s} className={MENU_ITEM} onClick={() => { setStatus(record.id, s); close(); }}>
                  {record.status === s ? <Check size={14} className="text-emerald" /> : <span className="w-3.5" />}<span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[s].dot} ${s === "replied" ? "ring-1 ring-emerald" : ""}`} />{STATUS_META[s].label}
                </button>)}
              </Menu>
            </div>
            <div className="flex items-center gap-2 sm:w-auto sm:justify-end">
              {confirmingId === record.id ? <>
                <span className="text-xs font-medium text-red-600">Delete?</span>
                <button className="btn-secondary !px-2.5 !py-1 text-xs text-red-600" onClick={() => remove(record.id)}>Confirm</button>
                <button className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => setConfirmingId("")}>Cancel</button>
              </> : <>
                <button className="btn-secondary !px-2.5 !py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50" disabled={!record.job.url} title={record.job.url ? "Open the job listing" : "No job link saved"} onClick={() => window.open(record.job.url, "_blank", "noopener")}><ExternalLink size={13} /> View job</button>
                <button className="btn-primary !px-2.5 !py-1.5 text-xs" onClick={() => { location.hash = `#editor/${record.tailoredCv.id}`; }}><FilePenLine size={13} /> See resume</button>
                <Menu className="btn-secondary !px-2 !py-1.5" label={<MoreVertical size={15} />}>
                  {(close) => <>
                    <button className={MENU_ITEM} onClick={() => { duplicate(record); close(); }}><Copy size={14} /> Duplicate</button>
                    <button className={MENU_ITEM} onClick={() => { exportRecord(record, "pdf"); close(); }}><Download size={14} /> Export PDF</button>
                    <button className={MENU_ITEM} onClick={() => { exportRecord(record, "docx"); close(); }}><Download size={14} /> Export DOCX</button>
                    <button className={`${MENU_ITEM} text-red-600`} onClick={() => { setConfirmingId(record.id); close(); }}><Trash2 size={14} /> Delete</button>
                  </>}
                </Menu>
              </>}
            </div>
          </div>;
        })}
      </div>
    </>}

    {toast && (
      <div key={toast.key} className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-2xl border border-line bg-white px-4 py-3 shadow-lg animate-toast">
        <span className={`h-2 w-2 shrink-0 rounded-full ${toast.dot} ${toast.label === "Replied" ? "ring-1 ring-emerald" : ""}`} />
        <span className="text-sm font-semibold text-ink">Marked as <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold ${toast.cls}`}>{toast.label}</span></span>
      </div>
    )}
  </Shell>;
}

function Account({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [apiBaseUrl, setApiBaseUrl] = useState(state.settings.apiBaseUrl);
  const [aiProvider, setAiProvider] = useState(state.settings.aiProvider);
  const [health, setHealth] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  async function signOut() {
    setSigningOut(true);
    try {
      if (state.auth) await authClient.signOut(state.settings.apiBaseUrl, state.auth.token);
      const next = await clearAuthSession();
      onChange(next);
      location.hash = "#home";
    } finally { setSigningOut(false); }
  }
  // Frontend-only "delete account": there is no server-side deletion endpoint, so
  // we best-effort end the session and wipe everything stored on this device.
  async function deleteAccount() {
    setDeleting(true);
    try {
      if (state.auth) await authClient.signOut(state.settings.apiBaseUrl, state.auth.token).catch(() => undefined);
      const next = emptyStorageState();
      await setState(next);
      onChange(next);
      location.hash = "#home";
    } finally { setDeleting(false); }
  }
  async function save() {
    const next = { ...state, settings: { ...state.settings, apiBaseUrl, aiProvider, tailoringEngine: "builtin" as const } }; await setState(next); onChange(next); setHealth("Settings saved. New AI requests will use the selected provider.");
  }
  async function check() {
    setHealth("Checking…");
    try { const result = await api.health(apiBaseUrl, aiProvider); setHealth(result.configured ? `Connected · ${result.provider} · ${result.model} · unified evidence pipeline` : "Local server connected, but the selected provider is not configured."); }
    catch (e) { if (!(await handleAuthExpiry(e, onChange))) setHealth((e as Error).message); }
  }
  return <Shell title="Account">
    <div className="mx-auto grid max-w-xl gap-5">
      <div className="card">
        <div><span className="label">Name</span><p className="text-sm font-semibold">{state.auth?.name || "—"}</p></div>
        <div className="mt-4"><span className="label">Email</span><p className="text-sm">{state.auth?.email || "—"}</p></div>

        <div className="mt-5 border-t border-line pt-5">
          <button className="btn-secondary" onClick={signOut} disabled={signingOut}><LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}</button>
        </div>
      </div>

      <div className="card border-red-200">
        <h2 className="section-title text-red-700">Delete account</h2>
        <p className="mt-1 text-sm text-muted">Permanently removes your data from this device and signs you out.</p>
        {confirmingDelete ? <div className="mt-4 flex items-center gap-2">
          <span className="text-sm font-medium text-red-600">Delete account?</span>
          <button className="btn-secondary text-red-600" onClick={deleteAccount} disabled={deleting}><Trash2 size={15} /> {deleting ? "Deleting…" : "Confirm"}</button>
          <button className="btn-secondary" onClick={() => setConfirmingDelete(false)} disabled={deleting}>Cancel</button>
        </div> : <button className="btn-secondary mt-4 border-red-200 text-red-600 hover:bg-red-50" onClick={() => setConfirmingDelete(true)}><Trash2 size={15} /> Delete account</button>}
      </div>

      <details className="card group [&_summary]:list-none">
        <summary className="flex cursor-pointer items-center justify-between">
          <div><h2 className="section-title">Advanced settings</h2><p className="mt-1 text-sm text-muted">AI provider and the local server URL.</p></div>
          <ChevronDown size={18} className="text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-4 border-t border-line pt-4">
          <label className="block"><span className="label">Provider</span>
            <select className="field" value={aiProvider} onChange={(e) => setAiProvider(e.target.value as AiProvider)}><option value="groq-api">Groq API (recommended)</option><option value="gemini-api">Gemini API</option><option value="openai-api">OpenAI API</option><option value="codex-local">Codex running on this machine</option></select>
          </label>
          <label className="mt-4 block"><span className="label">Local server URL</span><input className="field" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} /></label>
          <div className="mt-4 flex gap-2">
            <button className="btn-primary" onClick={save}><Save size={16} /> Save</button>
            <button className="btn-secondary" onClick={check}>Test selected provider</button>
          </div>
          {health && <p className="mt-3 text-sm text-muted">{health}</p>}
        </div>
      </details>
    </div>
  </Shell>;
}

function Welcome({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    if (state.settings.welcomeSeen) return;
    updateState((s) => ({ ...s, settings: { ...s.settings, welcomeSeen: true } })).then(onChange);
  }, []);
  // Hand the chosen file to Onboarding (across the hash nav) so it auto-structures
  // without asking the user to pick it a second time.
  const handoff = (file?: File | null) => { if (!file) return; pendingUploadFile = file; location.hash = "#onboarding/upload"; };
  return (
    <div className="min-h-screen bg-soft">
      <main className="mx-auto max-w-2xl px-4 py-12">
        <div className="flex items-center gap-2.5"><Logo /><span className="font-display font-bold">Fyxor</span></div>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[.1em] text-emerald">Welcome to Fyxor</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">You're one step from a CV that works.</h1>
        <p className="mt-3 max-w-xl text-muted">Drop in your résumé and we'll build your base CV in seconds. After that, tailor it to any job offer in a couple of clicks — honestly framed, never invented.</p>

        <label
          className={`onboarding-dropzone onboarding-dropzone-hero mt-7 ${dragOver ? "is-dragover" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handoff(e.dataTransfer.files?.[0]); }}>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-mint text-deep"><Upload size={24} /></span>
          <span className="mt-3 font-display text-lg font-bold tracking-tight">Drop your résumé here</span>
          <span className="mt-1 text-sm text-muted">or click to upload a PDF or DOCX — we'll structure it for you</span>
          <input type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => handoff(e.target.files?.[0])} />
        </label>

        <p className="mt-5 text-center text-sm text-muted">No résumé yet? <button className="font-semibold text-emerald hover:underline" onClick={() => { location.hash = "#onboarding/manual"; }}>Build it from scratch →</button></p>
      </main>
    </div>
  );
}

function PinScreen({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  useEffect(() => {
    if (state.settings.pinScreenSeen) return;
    updateState((s) => ({ ...s, settings: { ...s.settings, pinScreenSeen: true } })).then(onChange);
  }, []);
  return (
    <div className="min-h-screen bg-soft">
      <main className="mx-auto max-w-3xl px-4 py-12">
        <div className="flex items-center gap-2.5"><Logo /><span className="font-display font-bold">Fyxor</span></div>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[.1em] text-emerald">You're all set</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Your resume is ready 🎉</h1>
        <p className="mt-3 max-w-xl text-muted">Your base CV is saved. One last thing — pin Fyxor so it's one click away on every job post.</p>

        <div className="mt-8 rounded-2xl border border-line bg-white p-5">
          <div className="flex items-center gap-2 font-semibold"><Pin size={17} className="text-emerald" /> Pin Fyxor to your toolbar</div>
          <p className="mt-1 text-sm text-muted">So it's one click away on every job post.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-soft p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald text-xs font-bold text-white">1</span>
                <span className="text-sm font-medium text-ink">Click the extensions icon</span>
              </div>
              <svg viewBox="0 0 280 120" className="mt-3 w-full" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Click the puzzle-piece extensions icon in the browser toolbar">
                <defs>
                  <marker id="pin-arrow-up" markerWidth="8" markerHeight="8" refX="4" refY="8" orient="auto">
                    <polygon points="0,8 4,0 8,8" fill="#059669" />
                  </marker>
                </defs>
                {/* Browser frame */}
                <rect width="280" height="62" rx="8" fill="#DDE1E7" />
                {/* Tab */}
                <rect x="8" y="5" width="90" height="22" rx="5" fill="white" opacity="0.6" />
                <circle cx="20" cy="16" r="3.5" fill="#6ee7b7" />
                <rect x="28" y="13" width="50" height="6" rx="3" fill="#d1d5db" />
                {/* Toolbar row */}
                <rect x="0" y="27" width="280" height="35" fill="#DDE1E7" />
                {/* Back button */}
                <circle cx="16" cy="44" r="10" fill="white" opacity="0.4" />
                <path d="M19,40 L13,44 L19,48" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                {/* Forward button */}
                <circle cx="38" cy="44" r="10" fill="white" opacity="0.4" />
                <path d="M35,40 L41,44 L35,48" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                {/* Address bar */}
                <rect x="56" y="34" width="176" height="20" rx="10" fill="white" />
                <circle cx="68" cy="44" r="4" fill="#e5e7eb" />
                <rect x="76" y="41" width="90" height="6" rx="3" fill="#f3f4f6" />
                {/* Divider */}
                <line x1="238" y1="36" x2="238" y2="52" stroke="#c4c7cc" strokeWidth="1" />
                {/* Generic icon left of puzzle */}
                <circle cx="249" cy="44" r="8" fill="white" opacity="0.5" />
                <circle cx="249" cy="41" r="2" fill="#c4c7cc" />
                <rect x="245" y="44" width="8" height="3" rx="1.5" fill="#c4c7cc" />
                {/* Extensions puzzle icon — highlighted */}
                <circle cx="266" cy="44" r="13" fill="#d1fae5" />
                <circle cx="266" cy="44" r="13" fill="none" stroke="#059669" strokeWidth="2" />
                {/* 2×2 puzzle squares */}
                <g transform="translate(260,38)">
                  <rect x="0" y="0" width="5" height="5" rx="0.8" fill="#059669" />
                  <rect x="7" y="0" width="5" height="5" rx="0.8" fill="#059669" />
                  <rect x="0" y="7" width="5" height="5" rx="0.8" fill="#059669" />
                  <rect x="7" y="7" width="5" height="5" rx="0.8" fill="#059669" />
                  <circle cx="6" cy="2.5" r="1.5" fill="#d1fae5" />
                  <circle cx="2.5" cy="6" r="1.5" fill="#d1fae5" />
                  <circle cx="9.5" cy="6" r="1.5" fill="#059669" />
                  <circle cx="6" cy="9.5" r="1.5" fill="#059669" />
                </g>
                {/* Three-dot menu */}
                <circle cx="277" cy="41" r="1.3" fill="#9ca3af" />
                <circle cx="277" cy="44" r="1.3" fill="#9ca3af" />
                <circle cx="277" cy="47" r="1.3" fill="#9ca3af" />
                {/* Arrow pointing up to puzzle icon */}
                <line x1="266" y1="112" x2="266" y2="63" stroke="#059669" strokeWidth="2" strokeDasharray="4 3" markerEnd="url(#pin-arrow-up)" />
                <text x="266" y="119" fontSize="9" fill="#059669" fontWeight="600" textAnchor="middle">click here</text>
              </svg>
            </div>
            <div className="rounded-xl bg-soft p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald text-xs font-bold text-white">2</span>
                <span className="text-sm font-medium text-ink">Pin <strong>Fyxor</strong></span>
              </div>
              <svg viewBox="0 0 240 162" className="mt-3 w-full" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Find Fyxor in the extensions list and click its pin icon">
                <defs>
                  <marker id="pin-arrow-right" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                    <polygon points="0,0 8,3 0,6" fill="#059669" />
                  </marker>
                </defs>
                {/* Toolbar stub */}
                <rect width="240" height="24" rx="5" fill="#DDE1E7" opacity="0.7" />
                {/* Puzzle icon in toolbar (small) */}
                <circle cx="213" cy="12" r="10" fill="#d1fae5" />
                <circle cx="213" cy="12" r="10" fill="none" stroke="#059669" strokeWidth="1.5" />
                <g transform="translate(208,7)">
                  <rect x="0" y="0" width="4" height="4" rx="0.5" fill="#059669" />
                  <rect x="5" y="0" width="4" height="4" rx="0.5" fill="#059669" />
                  <rect x="0" y="5" width="4" height="4" rx="0.5" fill="#059669" />
                  <rect x="5" y="5" width="4" height="4" rx="0.5" fill="#059669" />
                </g>
                {/* Panel shadow */}
                <rect x="31" y="28" width="204" height="132" rx="10" fill="#6b7280" opacity="0.08" />
                <rect x="29" y="26" width="204" height="132" rx="10" fill="#6b7280" opacity="0.05" />
                {/* Panel body */}
                <rect x="27" y="24" width="206" height="134" rx="10" fill="white" stroke="#e5e7eb" strokeWidth="1" />
                {/* Header */}
                <text x="43" y="42" fontSize="9" fontWeight="700" fill="#6b7280" letterSpacing="0.8">EXTENSIONS</text>
                {/* Row 1 — generic */}
                <rect x="39" y="50" width="18" height="18" rx="4" fill="#bfdbfe" />
                <rect x="63" y="53" width="60" height="6" rx="3" fill="#d1d5db" />
                <rect x="63" y="61" width="40" height="4" rx="2" fill="#e5e7eb" />
                <circle cx="219" cy="59" r="9" fill="#f9fafb" />
                <circle cx="219" cy="56" r="3" fill="#d1d5db" />
                <rect x="218.5" y="58" width="1.5" height="5" rx="0.8" fill="#d1d5db" />
                {/* Divider */}
                <line x1="39" y1="74" x2="227" y2="74" stroke="#f3f4f6" strokeWidth="1" />
                {/* Row 2 — Fyxor highlighted */}
                <rect x="33" y="77" width="196" height="34" rx="6" fill="#f0fdf4" />
                <rect x="39" y="82" width="20" height="20" rx="4" fill="#059669" />
                <path d="M44,92 L47,96 L54,86" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <text x="65" y="93" fontSize="10" fontWeight="600" fill="#1f2937">Fyxor</text>
                <text x="65" y="104" fontSize="8" fill="#6b7280">Career toolkit</text>
                {/* Pin icon highlighted */}
                <circle cx="219" cy="94" r="11" fill="#d1fae5" stroke="#059669" strokeWidth="1.5" />
                <circle cx="219" cy="90" r="3.5" fill="#059669" />
                <rect x="218" y="93" width="2" height="6" rx="1" fill="#059669" />
                {/* Arrow to pin */}
                <line x1="150" y1="94" x2="204" y2="94" stroke="#059669" strokeWidth="2" strokeDasharray="4 3" markerEnd="url(#pin-arrow-right)" />
                <text x="146" y="98" fontSize="8" fill="#059669" fontWeight="600" textAnchor="end">pin it</text>
                {/* Divider */}
                <line x1="39" y1="117" x2="227" y2="117" stroke="#f3f4f6" strokeWidth="1" />
                {/* Row 3 — generic */}
                <rect x="39" y="121" width="18" height="18" rx="4" fill="#fde68a" />
                <rect x="63" y="124" width="70" height="6" rx="3" fill="#d1d5db" />
                <rect x="63" y="132" width="45" height="4" rx="2" fill="#e5e7eb" />
                <circle cx="219" cy="130" r="9" fill="#f9fafb" />
                <circle cx="219" cy="127" r="3" fill="#d1d5db" />
                <rect x="218.5" y="129" width="1.5" height="5" rx="0.8" fill="#d1d5db" />
              </svg>
            </div>
          </div>
        </div>

        <button className="btn-primary mt-8" onClick={() => { location.hash = "#home"; }}>Got it, take me in <ArrowRight size={16} /></button>
      </main>
    </div>
  );
}

function Auth({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = state.settings.apiBaseUrl;
  const provider = state.settings.aiProvider;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      const session = mode === "signup"
        ? await authClient.signUp(base, email.trim(), password, name.trim())
        : await authClient.signIn(base, email.trim(), password);
      let next = await setAuthSession(session);
      // Pull this account's cloud data and adopt it as local state. Best effort:
      // a brand-new account returns an empty payload, and an offline server just
      // leaves the freshly-signed-in session with empty local data.
      try {
        const cloud = await api.pullSync(base, provider);
        const cloudHasData = Boolean(cloud.profile) || cloud.applications.length > 0 || Object.keys(cloud.drafts).length > 0;
        // Only adopt the cloud copy when it actually holds data. If it's empty
        // (e.g. re-signing in after a session expiry that blocked the last push),
        // keep the local state so unsynced edits aren't clobbered by a blank pull.
        if (cloudHasData) {
          next = await updateState((s) => ({
            ...s,
            profile: cloud.profile,
            drafts: cloud.drafts,
            applications: cloud.applications,
            settings: { ...s.settings, onboardingComplete: Boolean(cloud.profile) }
          }));
        }
      } catch { /* empty/offline — proceed with the local state */ }
      onChange(next);
      location.hash = next.profile ? "#home" : "#welcome";
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen bg-soft">
      <main className="mx-auto max-w-md px-4 py-12">
        <div className="flex items-center gap-2.5"><Logo /><span className="font-display font-bold">Fyxor</span></div>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[.1em] text-emerald">{mode === "signup" ? "Create your account" : "Welcome back"}</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">{mode === "signup" ? "Start tailoring your CV" : "Sign in to Fyxor"}</h1>
        <p className="mt-3 text-muted">{mode === "signup" ? "Create an account to save your CV to the cloud and use it on any device." : "Sign in to load your saved CV and applications."}</p>

        <form className="card mt-8 space-y-4" onSubmit={submit}>
          {error && <ErrorBox message={error} />}
          {mode === "signup" && <label className="block"><span className="label">Name</span><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></label>}
          <label className="block"><span className="label">Email</span><input className="field" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
          <label className="block"><span className="label">Password</span><input className="field" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" /></label>
          <button className="btn-primary w-full" disabled={busy} type="submit">{busy ? <Loading label="Please wait…" /> : <>{mode === "signup" ? <><Sparkles size={16} /> Create account</> : <><ArrowRight size={16} /> Sign in</>}</>}</button>
        </form>

        <p className="mt-5 text-center text-sm text-muted">
          {mode === "signup" ? "Already have an account? " : "New to Fyxor? "}
          <button className="font-semibold text-emerald hover:underline" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); }}>
            {mode === "signup" ? "Sign in" : "Create one"}
          </button>
        </p>
      </main>
    </div>
  );
}

export function App() {
  const [state, setAppState] = useState<StorageState | null>(null);
  const [hash, setHash] = useState(location.hash || "#home");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  useEffect(() => { getState().then(setAppState); const listener = () => setHash(location.hash || "#home"); addEventListener("hashchange", listener); return () => removeEventListener("hashchange", listener); }, []);
  // Keep this tab's state fresh when another tab, the popup, or the background
  // worker writes to storage — otherwise two open tabs overwrite each other's
  // whole state (last-write-wins clobber). Actively-edited child screens seed
  // their local state on mount, so an external refresh re-renders without yanking
  // the field the user is currently typing in.
  useEffect(() => {
    if (!globalThis.chrome?.storage) return; // dev/localStorage path: no cross-tab events
    const KEY = "cvTailorState";
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[KEY]) setAppState(migrateStorage(changes[KEY].newValue));
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);
  // Replicate user data to the cloud (debounced, last-write-wins) whenever the
  // signed-in user's profile/drafts/applications change.
  useEffect(() => {
    if (!state?.auth) return;
    const timer = setTimeout(() => {
      api.pushSync(state.settings.apiBaseUrl, state.settings.aiProvider, {
        profile: state.profile,
        drafts: state.drafts,
        applications: state.applications
      }).then(() => setSyncState("synced"))
        .catch((e) => {
          // An expired session must drop the token and show the gate — not be
          // silently mislabeled "offline" forever. Genuine network errors keep
          // the honest offline indicator; local stays the source of truth.
          if (e instanceof AuthExpiredError) clearAuthToken().then(setAppState);
          else setSyncState("offline");
        });
    }, 1000);
    return () => clearTimeout(timer);
  }, [state?.profile, state?.drafts, state?.applications, state?.auth]);
  if (!state) return <div className="p-6"><Loading label="Loading Fyxor…" /></div>;
  // Hard gate: no access to any screen until an account exists on this device.
  if (!state.auth) return <Auth state={state} onChange={setAppState} />;
  if (hash === "#welcome") return <Welcome state={state} onChange={setAppState} />;
  if (hash === "#pin") return <PinScreen state={state} onChange={setAppState} />;
  // Resume an interrupted setup: an unfinished profile with a saved onboarding step
  // pulls the user back in rather than dropping them on a half-built home screen.
  if (state.profile && !state.settings.onboardingComplete && state.settings.onboardingStep && !hash.startsWith("#onboarding")) {
    location.hash = `#onboarding/${state.profile.rawText ? "upload" : "manual"}`;
    return <div className="p-6"><Loading label="Resuming your setup…" /></div>;
  }
  if (hash.startsWith("#onboarding")) return <Onboarding state={state} onChange={setAppState}
    initialMode={hash.split("/")[1] === "manual" ? "manual" : "upload"}
    initialView={hash.split("/")[1] === "evidence" ? "extras" : undefined} />;
  if (hash === "#resume") return <ResumeView state={state} onChange={setAppState} />;
  if (hash === "#account" || hash === "#profile") return <Account state={state} onChange={setAppState} />;
  if (hash === "#applications" || hash === "#tracker") return <Tracker state={state} onChange={setAppState} />;
  if (hash.startsWith("#editor/")) return <Editor state={state} cvId={hash.split("/")[1] || ""} onChange={setAppState} />;
  return <Home state={state} onChange={setAppState} />;
}
