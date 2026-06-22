import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, BriefcaseBusiness, Check, ChevronDown, Cloud, CloudOff,
  Download, FilePenLine, FileText, Lightbulb, LoaderCircle, LogOut, Mail, MousePointerClick,
  Palette, PenLine, Pin, Plus, Save, Sparkles, Trash2, Upload, User, X
} from "lucide-react";
import {
  applyRegeneratedSection,
  bulletHasMetric,
  cvStyleSchema,
  educationHasContent,
  effectiveSectionOrder,
  flattenSkillCategories,
  makeId,
  migrateStorage,
  normalizeSkillCategories,
  type ApplicationRecord,
  type BaseProfile,
  type CvStyle,
  type JobDescription,
  type StorageState,
  type TailoredCv,
  type TailoringEngine
} from "@cv-tailor/shared";
import { api, ApiError, AuthExpiredError } from "./api";
import { authClient } from "./auth";
import { CvDocument } from "@cv-tailor/shared";
import { ResumeStrength } from "./ResumeStrength";
import { evaluateResume } from "./resumeChecks";
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

function Onboarding({ state, onChange, initialMode = "upload" }: { state: StorageState; onChange: (s: StorageState) => void; initialMode?: "upload" | "manual" }) {
  const [step, setStep] = useState(initialMode === "manual" ? 2 : 1);
  const [rawText, setRawText] = useState(state.profile?.rawText || "");
  const [profile, setProfile] = useState<BaseProfile>(state.profile || {
    id: makeId("profile"), contact: { name: "", email: "", phone: "", location: "", linkedIn: "" },
    targetRole: "", outputLanguage: "en", summary: "", experiences: [], education: [], skills: [], skillCategories: {}, certifications: [], languages: [], sectionOrder: [], style: { preset: "modern" }, dismissedChecks: [], rawText: "", updatedAt: new Date().toISOString()
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const base = state.settings.apiBaseUrl;
  const provider = state.settings.aiProvider;

  async function parseFile(file?: File) {
    if (!file) return;
    setBusy("Reading CV…"); setError("");
    try {
      const result = await api.parseFile(base, provider, await fileToBase64(file), file.name);
      setRawText(result.text);
    } catch (e) { if (!(await handleAuthExpiry(e, onChange))) setError((e as Error).message); } finally { setBusy(""); }
  }

  async function structure() {
    if (rawText.trim().length < 30) return setError("Paste or upload enough CV text first.");
    setBusy("Structuring your profile…"); setError("");
    try {
      const result = await api.extract(base, provider, rawText, profile.outputLanguage);
      setProfile(result); setStep(2);
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

  async function finish() {
    const next = { ...state, profile: { ...profile, rawText, updatedAt: new Date().toISOString() }, settings: { ...state.settings, onboardingComplete: true } };
    await setState(next); onChange(next); location.hash = "#pin";
  }

  const BASIC_FIELDS = [
    { key: "name", label: "Full name *", placeholder: "Jane Doe", required: true },
    { key: "email", label: "Email *", placeholder: "you@example.com", required: true },
    { key: "phone", label: "Phone", placeholder: "+44 7700 900000", required: false },
    { key: "location", label: "Location", placeholder: "London, UK", required: false },
    { key: "linkedIn", label: "LinkedIn profile URL", placeholder: "https://linkedin.com/in/…", required: false }
  ] as const;

  // Once the required basics exist, let the user finish from any later step
  // instead of forcing a walk through all six.
  const basicsValid = profile.contact.name.trim().length > 0 && profile.contact.email.trim().length > 0;
  const canFinishEarly = step >= 2 && step < 6 && basicsValid;

  return <Shell title="Build your base profile" eyebrow="Your experience, properly framed">
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">{["CV source", "Basics", "Experience", "Skills & education", "Certifications & languages", "Review"][step - 1]}</span>
        <span className="text-xs font-semibold text-muted">Step {step} of 6</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-emerald transition-all duration-300" style={{ width: `${(step / 6) * 100}%` }} />
      </div>
    </div>
    <div className="card mx-auto max-w-3xl">
      {error && <div className="mb-4"><ErrorBox message={error} /></div>}
      {step === 1 && <>
        <h2 className="section-title">Start with your real CV</h2>
        <p className="mt-2 text-sm text-muted">Upload an existing file or paste your CV text. It's sent securely to AI to pull out your experience — we never store the file.</p>
        <label className="mt-5 flex cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line bg-soft p-7 text-sm font-semibold hover:border-emerald"><Upload size={18} /> Upload PDF or DOCX<input type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => parseFile(e.target.files?.[0])} /></label>
        <textarea className="field mt-4 min-h-64" placeholder="Or paste your CV text here…" value={rawText} onChange={(e) => setRawText(e.target.value)} />
        <div className="mt-4 flex items-center justify-between">{busy ? <Loading label={busy} /> : <span className="text-xs text-muted">{rawText.trim().length < 30 ? "Add a bit more text to continue" : "Looks good — ready to structure"}</span>}<div className="flex gap-2"><button className="btn-secondary" disabled={!!busy} onClick={() => setStep(2)}>Skip — enter details manually</button><button className="btn-primary" disabled={!!busy} onClick={structure}><Sparkles size={16} /> Structure with AI</button></div></div>
      </>}
      {step === 2 && <>
        <h2 className="section-title">Check the basics</h2><p className="mt-2 text-sm text-muted">These details appear on every tailored CV.</p>
        {initialMode === "manual" && <p className="mt-2 text-sm text-muted">Tip: upload a file or paste your CV on the previous step to auto-fill these.</p>}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {BASIC_FIELDS.map(({ key, label, placeholder, required }) => <label key={key}><span className="label">{label}</span><input className="field" required={required} placeholder={placeholder} value={profile.contact[key]} onChange={(e) => setProfile({ ...profile, contact: { ...profile.contact, [key]: e.target.value } })} /></label>)}
          <label><span className="label">Target role</span><input className="field" placeholder="Product Designer" value={profile.targetRole} onChange={(e) => setProfile({ ...profile, targetRole: e.target.value })} /></label>
        </div>
        <label className="mt-4 block"><span className="label">Current summary</span><textarea className="field min-h-28" value={profile.summary} onChange={(e) => setProfile({ ...profile, summary: e.target.value })} /></label>
      </>}
      {step === 3 && <>
        <div className="flex items-center justify-between"><div><h2 className="section-title">Make your evidence clear</h2><p className="mt-2 text-sm text-muted">Add only real duties and achievements. Tailoring will reframe these, never invent them.</p></div><button className="btn-secondary" onClick={addExperience}><Plus size={16} /> Role</button></div>
        <div className="mt-5 space-y-4">{profile.experiences.map((experience) => <div className="rounded-2xl border border-line bg-soft p-4" key={experience.id}>
          <div className="grid gap-3 sm:grid-cols-2">
            <input className="field" placeholder="Role" value={experience.role} onChange={(e) => updateExperience(experience.id, { role: e.target.value })} />
            <input className="field" placeholder="Company" value={experience.company} onChange={(e) => updateExperience(experience.id, { company: e.target.value })} />
            <input className="field" placeholder="Start (e.g. Jan 2021)" value={experience.startDate} onChange={(e) => updateExperience(experience.id, { startDate: e.target.value })} />
            <input className="field" placeholder="End (e.g. Present)" value={experience.endDate} onChange={(e) => updateExperience(experience.id, { endDate: e.target.value })} />
          </div>
          <textarea className="field mt-3 min-h-28" placeholder="One bullet per line" value={experience.bullets.join("\n")} onChange={(e) => updateExperience(experience.id, { bullets: e.target.value.split("\n") })} />
          {experience.bullets.some((b) => b.trim()) && !experience.bullets.some(bulletHasMetric) && <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600"><Lightbulb size={14} className="mt-px shrink-0" /> Add a number where you can — e.g. "cut deploy time 40%" or "led a team of 6". Metrics make tailoring far stronger.</p>}
          <div className="mt-3 flex justify-end"><button className="btn-secondary !px-3 text-red-600" onClick={() => removeExperience(experience.id)}><Trash2 size={15} /> Remove role</button></div>
        </div>)}</div>
        {!profile.experiences.length && <button className="mt-5 btn-secondary" onClick={addExperience}><Plus size={16} /> Add your first role</button>}
      </>}
      {step === 4 && <>
        <h2 className="section-title">Skills and education</h2><p className="mt-2 text-sm text-muted">Add your skills, then let AI sort them into clean, resume-ready categories. You can fine-tune the groups afterwards.</p>
        {!hasSkillCategories ? <>
          <div className="mt-5 flex items-center justify-between"><span className="label !mb-0">Your skills</span><button className="btn-secondary !px-3 !py-1.5 text-sm" disabled={!!busy || !profile.skills.length} onClick={groupSkills}>{busy === "Grouping your skills…" ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />} Group with AI</button></div>
          <SkillChips skills={profile.skills} onChange={setSkills} />
        </> : <>
          <div className="mt-5 flex items-center justify-between">
            <span className="label !mb-0">Skill categories</span>
            <div className="flex items-center gap-2">
              <button className="btn-secondary !px-3 !py-1.5 text-sm text-muted" onClick={() => setProfile({ ...profile, skillCategories: {}, skills: flattenSkillCategories(skillCategories) })}>Remove grouping</button>
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
        <div className="mt-5 flex items-center justify-between"><span className="label !mb-0">Education</span><button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={addEducation}><Plus size={15} /> Education</button></div>
        <div className="mt-3 space-y-3">{profile.education.map((entry) => <div className="rounded-2xl border border-line bg-soft p-3" key={entry.id}>
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
        {!profile.education.length && <button className="mt-3 btn-secondary" onClick={addEducation}><Plus size={16} /> Add your education</button>}
      </>}
      {step === 5 && <>
        <h2 className="section-title">Certifications and languages</h2><p className="mt-2 text-sm text-muted">Round out your profile. Leave anything blank if it doesn't apply.</p>
        <label className="mt-5 block"><span className="label">Certifications</span><textarea className="field min-h-28" placeholder="AWS Certified Solutions Architect, 2023" value={profile.certifications.join("\n")} onChange={(e) => setProfile({ ...profile, certifications: e.target.value.split("\n").filter(Boolean) })} /><span className="mt-1 block text-xs text-muted">One per line.</span></label>
        <div className="mt-5 flex items-center justify-between"><span className="label !mb-0">Languages</span><button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={addLanguage}><Plus size={15} /> Language</button></div>
        <div className="mt-3 space-y-3">{profile.languages.map((language, index) => <div className="flex items-center gap-3" key={index}>
          <input className="field" placeholder="Language (e.g. Spanish)" value={language.language} onChange={(e) => updateLanguage(index, { language: e.target.value })} />
          <input className="field" placeholder="Native / Fluent / B2" value={language.level} onChange={(e) => updateLanguage(index, { level: e.target.value })} />
          <button className="btn-secondary !px-3 text-red-600" onClick={() => removeLanguage(index)}><Trash2 size={15} /></button>
        </div>)}</div>
        {!profile.languages.length && <button className="mt-3 btn-secondary" onClick={addLanguage}><Plus size={16} /> Add a language</button>}
      </>}
      {step === 6 && <>
        <h2 className="section-title">Last look</h2><p className="mt-2 text-sm text-muted">Edit anything inline, then finish. You can keep refining everything later in the editor.</p>
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-soft p-4">
          <CvDocument cv={profile} editable headline={profile.targetRole}
            onChange={(next) => setProfile({ ...profile, ...next })}
            onCommitHeadline={(value) => setProfile({ ...profile, targetRole: value })} />
        </div>
      </>}
      {step > 1 && <div className="mt-6 flex items-center justify-between gap-2"><button className="btn-secondary" onClick={() => setStep(step - 1)}><ArrowLeft size={16} /> Back</button><div className="flex gap-2">{canFinishEarly && <button className="btn-secondary" onClick={finish}><Check size={16} /> Finish setup</button>}{step < 6 ? <button className="btn-primary" onClick={() => setStep(step + 1)}>Continue <ArrowRight size={16} /></button> : <button className="btn-primary" onClick={finish}><Check size={16} /> Finish setup</button>}</div></div>}
    </div>
  </Shell>;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  if (globalThis.chrome?.downloads) chrome.downloads.download({ url, filename: fileName, saveAs: true });
  else { const a = document.createElement("a"); a.href = url; a.download = fileName; a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 3000);
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
      setCv((prev) => (prev ? applyRegeneratedSection(prev, result, section, experienceId) : result));
    }
    catch (e) { if (!(await handleAuthExpiry(e, onChange))) setError((e as Error).message); } finally { setBusy(""); }
  }
  async function exportCv(format: "pdf" | "docx") {
    setBusy(`Creating ${format.toUpperCase()}…`); setError("");
    try { downloadBlob(await api.export(state.settings.apiBaseUrl, state.settings.aiProvider, currentCv, format), `${currentCv.job.company || "tailored"}-${currentCv.job.title || "cv"}.${format}`); }
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
        {!!cv.unsupportedClaims.length && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4"><div className="flex gap-2 font-semibold text-amber-900"><AlertTriangle size={18} /> Review possible unsupported claims</div>{cv.unsupportedClaims.map((claim) => <p className="mt-2 text-sm text-amber-900" key={claim.text}><strong>{claim.section}:</strong> {claim.text} — {claim.reason}</p>)}</div>}
        <FirstEditHint state={state} onChange={onChange} />
        <div className="rounded-2xl bg-soft p-3 ring-1 ring-line sm:p-6"><CvDocument cv={cv} editable onChange={(next) => { setCv(next as TailoredCv); markEdited.editing(); }} onCommitHeadline={(v) => { setCv({ ...currentCv, job: { ...currentCv.job, title: v } }); markEdited.editing(); }} onRegenerate={regenerate} busy={!!busy} /></div>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <InlineEditHint saveState={saveState}>Click any line in the resume to rewrite it. Hover a section heading to <span className="font-semibold text-emerald">Regenerate</span> or reorder with the ▲▼ arrows.</InlineEditHint>
        <StrengthPanel state={state} doc={currentCv} kind="tailored" onChange={onChange}
          onDismiss={(id) => { setCv({ ...currentCv, dismissedChecks: [...(currentCv.dismissedChecks ?? []), id] }); markEdited.editing(); }} />
        <StylePanel value={currentCv.style} onChange={(style) => { setCv({ ...currentCv, style }); markEdited.editing(); }} />
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
        <div className="card"><p className="text-sm font-semibold">Download</p><p className="mt-1 text-xs text-muted">Exports exactly what you see — a clean single-column ATS layout.</p><div className="mt-4 flex gap-2"><button className="btn-primary flex-1" onClick={() => exportCv("pdf")}><Download size={16} /> PDF</button><button className="btn-secondary flex-1" onClick={() => exportCv("docx")}><Download size={16} /> DOCX</button></div></div>
        <button className="btn-secondary w-full" onClick={() => { location.hash = "#applications"; }}><ArrowLeft size={16} /> Back to applications</button>
      </aside>
    </div>
  </Shell>;
}

function Home({ state }: { state: StorageState }) {
  const recent = [...state.applications]
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    .slice(0, 3);
  return <Shell title="Home" eyebrow="Your experience, properly framed">
    {!state.profile && <div className="mb-5 card flex flex-col gap-4 border-emerald sm:flex-row sm:items-center sm:justify-between">
      <div><p className="font-semibold">Create your first resume</p><p className="text-sm text-muted">Set up your base CV once, then tailor it to any job in a couple of clicks.</p></div>
      <button className="btn-primary shrink-0" onClick={() => location.hash = "#onboarding"}><Sparkles size={16} /> Get started</button>
    </div>}
    <div className="mb-3 flex items-center justify-between">
      <h2 className="section-title">Recently tailored</h2>
      {!!state.applications.length && <button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={() => location.hash = "#applications"}>View all <ArrowRight size={14} /></button>}
    </div>
    {!recent.length ? <EmptyApplications extra={!state.profile ? "Start by creating your base resume above." : undefined} /> :
    <div className="grid content-start gap-4">{recent.map((record) => <div key={record.id} className="card flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1"><h3 className="truncate font-display text-lg font-bold">{record.job.title || "Untitled job"}</h3><p className="text-sm text-muted">{record.job.company || "Unknown company"} · {new Date(record.createdAt).toLocaleDateString()}</p></div>
      <button className="btn-primary shrink-0 !px-3" onClick={() => { location.hash = `#editor/${record.tailoredCv.id}`; }}><FilePenLine size={15} /> Open</button>
    </div>)}</div>}
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

  return <Shell title="Your resume">
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
      <div>
        <FirstEditHint state={state} onChange={onChange} />
        <div className="rounded-2xl bg-soft p-3 ring-1 ring-line sm:p-6"><CvDocument cv={profile} headline={profile.targetRole} editable onChange={(next) => { setProfile({ ...profile, ...(next as Partial<BaseProfile>) }); markEdited.editing(); }} onCommitHeadline={(v) => { setProfile({ ...profile, targetRole: v.trim() }); markEdited.editing(); }} /></div>
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

function Tracker({ state, onChange }: { state: StorageState; onChange: (s: StorageState) => void }) {
  const [selectedId, setSelectedId] = useState(state.applications[0]?.id || "");
  const [confirmingId, setConfirmingId] = useState("");
  async function remove(id: string) {
    setConfirmingId("");
    const next = await updateState((s) => {
      const removed = s.applications.find((a) => a.id === id);
      // Also drop the orphaned draft so deleted CVs don't accumulate in storage
      // (and get pushed to the cloud) forever. Drafts aren't shared between
      // records, so the draft id is safe to remove with its application.
      const drafts = { ...s.drafts };
      if (removed) delete drafts[removed.tailoredCv.id];
      return { ...s, drafts, applications: s.applications.filter((a) => a.id !== id) };
    });
    onChange(next);
    if (id === selectedId) setSelectedId(next.applications[0]?.id || "");
  }
  async function duplicate(record: ApplicationRecord) {
    const cv = { ...record.tailoredCv, id: makeId("cv"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const copy = { ...record, id: makeId("application"), tailoredCv: cv, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const next = await updateState((s) => ({ ...s, drafts: { ...s.drafts, [cv.id]: cv }, applications: [copy, ...s.applications] }));
    onChange(next);
    setSelectedId(copy.id);
  }
  const selected = state.applications.find((a) => a.id === selectedId) || state.applications[0];
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

  return <Shell title="Applications">
    {!state.settings.onboardingComplete && <div className="mb-5 card flex items-center justify-between"><div><p className="font-semibold">Complete your base profile</p><p className="text-sm text-muted">Tailoring needs verified source experience.</p></div><button className="btn-primary" onClick={() => location.hash = "#onboarding"}>Start onboarding</button></div>}
    {!state.applications.length ? <EmptyApplications /> :
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)]">
      <div className="grid content-start gap-4">{state.applications.map((record) => <div role="button" tabIndex={0} onClick={() => setSelectedId(record.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(record.id); } }} className={`card flex cursor-pointer flex-col gap-4 transition sm:flex-row sm:items-center ${record.id === selected?.id ? "ring-2 ring-emerald" : "hover:border-emerald"}`} key={record.id}><div className="min-w-0 flex-1"><h2 className="truncate font-display text-lg font-bold">{record.job.title || "Untitled job"}</h2><p className="text-sm text-muted">{record.job.company || "Unknown company"} · {new Date(record.createdAt).toLocaleDateString()}</p></div>{confirmingId === record.id ? <div className="flex items-center gap-2"><span className="text-sm font-medium text-red-600">Delete?</span><button className="btn-secondary !px-3 text-red-600" onClick={stop(() => remove(record.id))}><Trash2 size={15} /> Confirm</button><button className="btn-secondary !px-3" onClick={stop(() => setConfirmingId(""))}>Cancel</button></div> : <div className="flex gap-2"><button className="btn-primary !px-3" onClick={stop(() => { location.hash = `#editor/${record.tailoredCv.id}`; })}><FilePenLine size={15} /> Open</button><button className="btn-secondary !px-3" aria-label="Duplicate" onClick={stop(() => duplicate(record))}><Plus size={15} /></button><button className="btn-secondary !px-3 text-red-600" aria-label="Delete" onClick={stop(() => setConfirmingId(record.id))}><Trash2 size={15} /></button></div>}</div>)}</div>
      <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><FileText size={14} /> Resume preview</div>
          {selected && <button className="btn-secondary !px-3 !py-1.5 text-sm" onClick={() => { location.hash = `#editor/${selected.tailoredCv.id}`; }}><FilePenLine size={14} /> Edit</button>}
        </div>
        {selected ? <div className="max-h-[calc(100vh-12rem)] overflow-y-auto rounded-2xl bg-soft p-3 ring-1 ring-line"><CvDocument cv={selected.tailoredCv} /></div>
          : <div className="card py-12 text-center text-sm text-muted">Select an application to preview its tailored resume.</div>}
      </aside>
    </div>}
  </Shell>;
}

function Account({ state, onChange, syncState }: { state: StorageState; onChange: (s: StorageState) => void; syncState: SyncState }) {
  const [apiBaseUrl, setApiBaseUrl] = useState(state.settings.apiBaseUrl);
  const [aiProvider, setAiProvider] = useState(state.settings.aiProvider);
  const [tailoringEngine, setTailoringEngine] = useState<TailoringEngine>(state.settings.tailoringEngine);
  const [cccAvailable, setCccAvailable] = useState(false);
  const [health, setHealth] = useState("");
  const [usage, setUsage] = useState<{ total: number; byAction: Record<string, number> } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    api.health(state.settings.apiBaseUrl, state.settings.aiProvider).then((result) => setCccAvailable(Boolean(result.ccc?.available))).catch(() => setCccAvailable(false));
    api.usage(state.settings.apiBaseUrl, state.settings.aiProvider).then(setUsage).catch(() => setUsage(null));
  }, []);
  async function signOut() {
    setSigningOut(true);
    try {
      if (state.auth) await authClient.signOut(state.settings.apiBaseUrl, state.auth.token);
      const next = await clearAuthSession();
      onChange(next);
      location.hash = "#home";
    } finally { setSigningOut(false); }
  }
  async function save() {
    const next = { ...state, settings: { ...state.settings, apiBaseUrl, aiProvider, tailoringEngine } }; await setState(next); onChange(next); setHealth("Settings saved. New AI requests will use the selected provider.");
  }
  async function setLanguage(outputLanguage: "en" | "pl") {
    const next = await updateState((s) => (s.profile ? { ...s, profile: { ...s.profile, outputLanguage, updatedAt: new Date().toISOString() } } : s));
    onChange(next);
  }
  async function check() {
    setHealth("Checking…");
    try { const result = await api.health(apiBaseUrl, aiProvider); setCccAvailable(Boolean(result.ccc?.available)); setHealth(result.configured ? `Connected · ${result.provider} · ${result.model}${result.ccc?.available ? " · CCC engine ready" : ""}` : "Local server connected, but OPENAI_API_KEY is missing."); }
    catch (e) { if (!(await handleAuthExpiry(e, onChange))) setHealth((e as Error).message); }
  }
  return <Shell title="Account & settings">
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="card">
        <h2 className="section-title">Base profile</h2>
        {state.profile ? <>
          <p className="mt-3 font-semibold">{state.profile.contact.name || "Unnamed profile"}</p>
          <p className="text-sm text-muted">{state.profile.targetRole || "No target role"} · {state.profile.experiences.length} roles · {state.profile.skills.length} skills</p>
          <div className="mt-5 flex gap-2">
            <button className="btn-primary" onClick={() => location.hash = "#resume"}><FilePenLine size={16} /> Edit resume</button>
            <button className="btn-secondary" onClick={() => location.hash = "#onboarding"}><PenLine size={16} /> Guided setup</button>
          </div>
          <label className="mt-4 block"><span className="label">Output language</span>
            <select className="field" value={state.profile.outputLanguage} onChange={(e) => setLanguage(e.target.value as "en" | "pl")}><option value="en">English</option><option value="pl">Polish</option></select>
            <span className="mt-1 block text-xs text-muted">Default language for tailored CVs.</span>
          </label>
        </> : <button className="btn-primary mt-5" onClick={() => location.hash = "#onboarding"}>Create profile</button>}
      </div>

      <div className="card">
        <h2 className="section-title">Account</h2>
        <div className="mt-3 flex items-center gap-2 text-sm"><User size={16} className="text-emerald" /><span className="font-semibold">{state.auth?.name || "Signed in"}</span></div>
        <div className="mt-1 flex items-center gap-2 text-sm text-muted"><Mail size={16} /><span>{state.auth?.email || ""}</span></div>
        <SyncIndicator state={syncState} />
        {usage && <p className="mt-3 text-xs text-muted">This month: {usage.byAction.tailor || 0} tailored · {usage.total} AI actions total.</p>}
        <button className="btn-secondary mt-4" onClick={signOut} disabled={signingOut}><LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}</button>
      </div>

      <details className="card group lg:col-span-2 [&_summary]:list-none">
        <summary className="flex cursor-pointer items-center justify-between">
          <div><h2 className="section-title">Advanced settings</h2><p className="mt-1 text-sm text-muted">AI provider, tailoring engine, and the local server URL.</p></div>
          <ChevronDown size={18} className="text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-4 border-t border-line pt-4">
          <label className="block"><span className="label">Provider</span>
            <select className="field" value={aiProvider} onChange={(e) => setAiProvider(e.target.value as "codex-local" | "openai-api" | "gemini-api")}><option value="gemini-api">Gemini API (recommended)</option><option value="openai-api">OpenAI API</option><option value="codex-local">Codex running on this machine</option></select>
          </label>
          <label className="mt-4 block"><span className="label">Tailoring engine</span>
            <select className="field" value={tailoringEngine} onChange={(e) => setTailoringEngine(e.target.value as TailoringEngine)}><option value="ccc" disabled={!cccAvailable}>CCC studio engine{cccAvailable ? " (recommended)" : " — not detected"}</option><option value="builtin">Built-in (single pass)</option></select>
            <span className="mt-1 block text-xs text-muted">{tailoringEngine === "ccc" ? (cccAvailable ? "Default. Runs the multi-step CCC pipeline — can take a few minutes per CV." : "CCC isn't detected on the server, so tailoring uses the built-in single pass until you set CCC_ENGINE_ROOT.") : "Fast single LLM pass via the selected provider."}</span>
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
  useEffect(() => {
    if (state.settings.welcomeSeen) return;
    updateState((s) => ({ ...s, settings: { ...s.settings, welcomeSeen: true } })).then(onChange);
  }, []);
  return (
    <div className="min-h-screen bg-soft">
      <main className="mx-auto max-w-3xl px-4 py-12">
        <div className="flex items-center gap-2.5"><Logo /><span className="font-display font-bold">Fyxor</span></div>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[.1em] text-emerald">Welcome to Fyxor</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">You're one step from a CV that works.</h1>
        <p className="mt-3 max-w-xl text-muted">Set up your base CV once. After that, tailor it to any job offer in a couple of clicks — honestly framed, never invented.</p>
        <p className="mt-6 text-sm font-medium text-ink">How would you like to start?</p>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <button className="card group text-left transition hover:border-emerald" onClick={() => { location.hash = "#onboarding/upload"; }}>
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-mint text-deep"><Upload size={20} /></span>
            <h2 className="mt-4 section-title">Upload an existing file</h2>
            <p className="mt-1 text-sm text-muted">Bring a PDF or DOCX résumé and we'll structure it for you.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald">Start <ArrowRight size={15} /></span>
          </button>
          <button className="card group text-left transition hover:border-emerald" onClick={() => { location.hash = "#onboarding/manual"; }}>
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-mint text-deep"><PenLine size={20} /></span>
            <h2 className="mt-4 section-title">Use our resume creator</h2>
            <p className="mt-1 text-sm text-muted">No file yet? Build your base CV step by step, from scratch.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald">Start <ArrowRight size={15} /></span>
          </button>
        </div>
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
  if (hash.startsWith("#onboarding")) return <Onboarding state={state} onChange={setAppState} initialMode={hash.split("/")[1] === "manual" ? "manual" : "upload"} />;
  if (hash === "#resume") return <ResumeView state={state} onChange={setAppState} />;
  if (hash === "#account" || hash === "#profile") return <Account state={state} onChange={setAppState} syncState={syncState} />;
  if (hash === "#applications" || hash === "#tracker") return <Tracker state={state} onChange={setAppState} />;
  if (hash.startsWith("#editor/")) return <Editor state={state} cvId={hash.split("/")[1] || ""} onChange={setAppState} />;
  return <Home state={state} />;
}
