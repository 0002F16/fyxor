import React, { createElement, Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Globe, Linkedin, Mail, MapPin, Phone, Plus, RefreshCw, X } from "lucide-react";
import {
  educationHasContent,
  effectiveSectionOrder,
  flattenSkillCategories,
  formatEducationEntry,
  makeId,
  normalizeSkillCategories,
  resumeStyleVars,
  bulletText,
  type BaseProfile,
  type CvStyle,
  type EducationEntry,
  type SectionId
} from "@cv-tailor/shared";

// The subset of fields the canvas actually renders. Both TailoredCv and
// BaseProfile satisfy this, so the same WYSIWYG canvas powers the tailored-CV
// editor and the base-resume editor. `job` is optional — base profiles have a
// `targetRole` headline passed in via the `headline` prop instead.
export type ResumeDocument = {
  contact: BaseProfile["contact"];
  summary: string;
  experiences: Array<Omit<BaseProfile["experiences"][number], "bullets"> & {
    bullets: Array<string | { id: string; text: string; sourceBulletIndexes: number[]; evidenceStatus: string }>;
    originalRole?: string;
    titleEvidenceStatus?: string;
  }>;
  education: EducationEntry[];
  skills: string[];
  skillCategories: Record<string, string[]>;
  certifications: string[];
  languages: BaseProfile["languages"];
  sectionOrder?: string[];
  style?: CvStyle;
  job?: { title?: string };
};

type EditableTag = "span" | "p" | "h1" | "li" | "div";
type EvidenceLine = { id: string; text: string; sourceBulletIndexes: number[]; evidenceStatus: string };

// A single inline-editable text node. The DOM is the source of truth while
// focused; we only push committed text up on blur so React never fights the
// caret. useLayoutEffect re-syncs the text when the value changes externally
// (e.g. a Regenerate call) but never while the field is focused.
function Editable({ value, onCommit, tag = "span", className = "", placeholder }: {
  value: string;
  onCommit: (next: string) => void;
  tag?: EditableTag;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value]);
  return createElement(tag, {
    ref,
    contentEditable: true,
    suppressContentEditableWarning: true,
    spellCheck: true,
    "data-placeholder": placeholder,
    className: `cv-editable ${className}`,
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      const next = (event.currentTarget.textContent || "").replace(/\s+/g, " ").trim();
      if (next !== value) onCommit(next);
    },
    onPaste: (event: React.ClipboardEvent<HTMLElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain").replace(/\s+/g, " ");
      document.execCommand("insertText", false, text);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter") { event.preventDefault(); (event.currentTarget as HTMLElement).blur(); }
    }
  });
}

// Renders editable text when in edit mode, otherwise plain static text — so the
// preview and the editor share one layout and stay truly WYSIWYG.
function Text({ editable, value, onCommit, tag = "span", className, placeholder }: {
  editable: boolean;
  value: string;
  onCommit?: (next: string) => void;
  tag?: EditableTag;
  className?: string;
  placeholder?: string;
}) {
  if (editable && onCommit) return <Editable value={value} onCommit={onCommit} tag={tag} className={className} placeholder={placeholder} />;
  return createElement(tag, { className }, value);
}

// Builds the ordered contact line shown directly under the name — location,
// phone, email, then LinkedIn. Mirrors the order used by the PDF/DOCX export
// (apps/api/src/export.ts) so the on-screen preview is true WYSIWYG.
function contactItems(contact: ResumeDocument["contact"]) {
  const isUrl = (value: string) => /^https?:\/\//i.test(value) || value.includes("linkedin.com");
  return [
    contact.location && { icon: MapPin, value: contact.location },
    contact.phone && { icon: Phone, value: contact.phone },
    contact.email && { icon: Mail, value: contact.email },
    contact.linkedIn && { icon: isUrl(contact.linkedIn) ? Linkedin : Globe, value: contact.linkedIn.replace(/^https?:\/\//i, "") }
  ].filter(Boolean) as Array<{ icon: typeof MapPin; value: string }>;
}

function Section({ title, children, onRegenerate, onRemove, onMoveUp, onMoveDown, busy, contentBlock }: {
  title: string;
  children: React.ReactNode;
  onRegenerate?: () => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  busy?: boolean;
  // When the section's whole content is one short, unbreakable unit (summary,
  // languages, certifications) mark the content wrapper as a single pagination
  // block. Sections with their own per-entry blocks (experience, skills,
  // education) leave this off and mark the entries instead.
  contentBlock?: boolean;
}) {
  return (
    <section className="group/sec mt-3 first:mt-0">
      <div className="flex items-center justify-between border-b border-line pb-1">
        <h2 data-cvblock="heading" className="font-display text-[11px] font-bold uppercase tracking-[.14em] text-deep">{title}</h2>
        <span className="inline-flex items-center gap-1">
          {(onMoveUp || onMoveDown) && (
            <span className="cv-control inline-flex items-center">
              <button type="button" onClick={onMoveUp} disabled={!onMoveUp}
                className="inline-flex items-center rounded-md px-0.5 py-0.5 text-muted hover:text-emerald disabled:opacity-25" aria-label="Move section up">
                <ChevronUp size={13} />
              </button>
              <button type="button" onClick={onMoveDown} disabled={!onMoveDown}
                className="inline-flex items-center rounded-md px-0.5 py-0.5 text-muted hover:text-emerald disabled:opacity-25" aria-label="Move section down">
                <ChevronDown size={13} />
              </button>
            </span>
          )}
          {onRegenerate && (
            <button type="button" disabled={busy} onClick={onRegenerate}
              className="cv-control inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-emerald hover:bg-mint disabled:opacity-40">
              <RefreshCw size={11} /> Regenerate
            </button>
          )}
          {onRemove && (
            <button type="button" onClick={onRemove}
              className="cv-control inline-flex items-center rounded-md px-1 py-0.5 text-muted hover:text-red-500" aria-label="Remove section">
              <X size={12} />
            </button>
          )}
        </span>
      </div>
      <div data-cvblock={contentBlock ? "block" : undefined} className="mt-1.5 text-[12.5px] leading-snug text-ink">{children}</div>
    </section>
  );
}

// Bulleted/line list with per-row inline editing and add/remove affordances.
function EditList({ items, editable, onChange, addLabel, placeholder, disc = true }: {
  items: Array<string | EvidenceLine>;
  editable: boolean;
  onChange: (next: Array<string | EvidenceLine>) => void;
  addLabel: string;
  placeholder: string;
  disc?: boolean;
}) {
  const editRow = (index: number, value: string) => {
    const next = [...items];
    const current = next[index];
    if (value.trim()) {
      next[index] = typeof current === "string"
        ? value.trim()
        : current
          ? { ...current, text: value.trim(), evidenceStatus: "stale" }
          : value.trim();
    } else next.splice(index, 1);
    onChange(next);
  };
  return (
    <ul className={`space-y-0.5 ${disc ? "list-disc pl-4 marker:text-emerald" : ""}`}>
      {items.map((line, index) => (
        // `relative` so the remove control can sit in the canvas gutter (absolute,
        // outside the text flow) — keeps the editable column the same width as the
        // exported output instead of reserving an inline slot for the button.
        <li className="group/row relative" key={typeof line === "string" ? index : line.id}>
          <Text editable={editable} value={bulletText(line as never)} onCommit={(value) => editRow(index, value)} placeholder={placeholder} />
          {editable && typeof line !== "string" && line.evidenceStatus !== "verified" && (
            <span className={`ml-1 text-[9px] font-semibold uppercase ${line.evidenceStatus === "unsupported" ? "text-red-500" : "text-amber-500"}`}>
              {line.evidenceStatus === "stale" ? "edited" : line.evidenceStatus.replace("-", " ")}
            </span>
          )}
          {editable && (
            <button type="button" onClick={() => editRow(index, "")} className="cv-control absolute -right-6 top-0 text-muted hover:text-red-500" aria-label="Remove">
              <X size={12} />
            </button>
          )}
        </li>
      ))}
      {editable && (
        <li className="list-none">
          <button type="button" onClick={() => onChange([...items, ""])} className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald hover:underline">
            <Plus size={12} /> {addLabel}
          </button>
        </li>
      )}
    </ul>
  );
}

const CONTACT_FIELDS = [
  { key: "location" as const, icon: MapPin, placeholder: "City, Country" },
  { key: "phone" as const, icon: Phone, placeholder: "Phone" },
  { key: "email" as const, icon: Mail, placeholder: "Email" },
  { key: "linkedIn" as const, icon: Linkedin, placeholder: "LinkedIn" }
];

export function CvDocument({ cv, headline: headlineProp, editable = false, lockExperienceFacts = false, onChange, onCommitHeadline, onRegenerate, busy = false }: {
  cv: ResumeDocument;
  headline?: string;
  editable?: boolean;
  lockExperienceFacts?: boolean;
  onChange?: (cv: ResumeDocument) => void;
  onCommitHeadline?: (value: string) => void;
  onRegenerate?: (section: "summary" | "experience" | "skills", experienceId?: string) => void;
  busy?: boolean;
}) {
  const headline = headlineProp ?? cv.job?.title;

  // A4 page-break guides: measure the rendered canvas height and mark every
  // page boundary. The guides are an approximate predictor of the server PDF
  // (font metrics differ), shown only while editing.
  const pageRef = useRef<HTMLElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  useEffect(() => {
    const el = pageRef.current;
    if (!editable || !el) return;
    const measure = () => setContentHeight(el.scrollHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [editable]);
  // The server PDF prints A4 (1123px tall at 96dpi) with a 0.5in (48px) margin on
  // every side, so each printed page only holds ~1027px of content. Place a guide
  // at the end of each page's printable band so multi-page resumes preview where
  // they will actually break.
  const PAGE_MARGIN_PX = 48;
  const PAGE_PRINTABLE_PX = 1123 - 2 * PAGE_MARGIN_PX;
  const pageBreaks: number[] = [];
  if (editable) for (let n = 1; PAGE_MARGIN_PX + n * PAGE_PRINTABLE_PX < contentHeight; n++) pageBreaks.push(PAGE_MARGIN_PX + n * PAGE_PRINTABLE_PX);

  const update = (patch: Partial<ResumeDocument>) => onChange?.({ ...cv, ...patch });
  const setContact = (key: keyof ResumeDocument["contact"], value: string) => update({ contact: { ...cv.contact, [key]: value } });
  const setExperience = (id: string, patch: Partial<ResumeDocument["experiences"][number]>) =>
    update({ experiences: cv.experiences.map((experience) => (experience.id === id ? { ...experience, ...patch } : experience)) });
  const setBullets = (id: string, next: Array<string | EvidenceLine>) => setExperience(id, { bullets: next });
  const addExperience = () =>
    update({ experiences: [...cv.experiences, { id: makeId("exp"), company: "", role: "", startDate: "", endDate: "", bullets: [] }] });
  const removeExperience = (id: string) => update({ experiences: cv.experiences.filter((experience) => experience.id !== id) });

  const setEducation = (id: string, patch: Partial<EducationEntry>) =>
    update({ education: cv.education.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) });
  const addEducation = () =>
    update({ education: [...cv.education, { id: makeId("edu"), school: "", degree: "", location: "", graduationDate: "", gpa: "", honors: "", coursework: [] }] });
  const removeEducation = (id: string) => update({ education: cv.education.filter((entry) => entry.id !== id) });

  // Skills are stored as { category: entries[] } plus a flat `skills` union the
  // export and stats read. Normalize legacy flat-only data into one "Skills"
  // category so editing is uniform, and keep the flat list synced on every edit.
  const categories = normalizeSkillCategories(cv.skillCategories, cv.skills, editable);
  const writeCategories = (cats: Array<[string, string[]]>) => {
    const seen = new Set<string>();
    const deduped = cats.map(([name, entries]): [string, string[]] => {
      let key = name;
      let i = 2;
      while (seen.has(key)) key = name ? `${name} ${i++}` : `${i++}`;
      seen.add(key);
      return [key, entries];
    });
    update({ skillCategories: Object.fromEntries(deduped), skills: flattenSkillCategories(deduped) });
  };

  const contacts = contactItems(cv.contact);
  const education = editable ? cv.education : cv.education.filter(educationHasContent);
  const certifications = editable ? cv.certifications : cv.certifications.filter(Boolean);
  const languages = editable ? cv.languages : cv.languages.filter((language) => language.language);

  // --- Section ordering -----------------------------------------------------
  // Resolve the stored order, decide which sections actually render as a movable
  // Section, and wire up-/down-arrows that swap two ids within the full order.
  const order = effectiveSectionOrder(cv.sectionOrder);
  const present: Record<SectionId, boolean> = {
    summary: editable || Boolean(cv.summary.trim()),
    experience: editable || cv.experiences.length > 0,
    skills: editable || categories.some(([, entries]) => entries.filter(Boolean).length > 0),
    certifications: certifications.length > 0,
    languages: languages.length > 0,
    education: editable || education.length > 0
  };
  const renderedIds = order.filter((id) => present[id]);
  const swapSections = (a: SectionId, b: SectionId) => {
    const next = [...order];
    const ia = next.indexOf(a);
    const ib = next.indexOf(b);
    const tmp = next[ia]!;
    next[ia] = next[ib]!;
    next[ib] = tmp;
    update({ sectionOrder: next });
  };
  type MoveProps = { onMoveUp?: () => void; onMoveDown?: () => void };
  const moveProps = (id: SectionId): MoveProps => {
    if (!editable || !present[id]) return {};
    const pos = renderedIds.indexOf(id);
    return {
      onMoveUp: pos > 0 ? () => swapSections(id, renderedIds[pos - 1]!) : undefined,
      onMoveDown: pos < renderedIds.length - 1 ? () => swapSections(id, renderedIds[pos + 1]!) : undefined
    };
  };

  const sections: Record<SectionId, ReactNode> = {
    summary: (editable || cv.summary.trim()) ? (
      <Section title="Profile" contentBlock onRegenerate={onRegenerate && (() => onRegenerate("summary"))} busy={busy} {...moveProps("summary")}>
        <Text editable={editable} value={cv.summary} onCommit={(value) => update({ summary: value })} tag="p" placeholder="Write a short professional summary…" />
      </Section>
    ) : null,

    experience: (editable || cv.experiences.length > 0) ? (
      <Section title="Experience" {...moveProps("experience")}>
        <div className="space-y-2.5">
          {cv.experiences.map((experience) => (
            <div data-cvblock="block" className="group/sec relative break-inside-avoid" key={experience.id}>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <Text editable={editable} value={experience.role} onCommit={(value) => setExperience(experience.id, { role: value })}
                    tag="p" className="font-semibold text-ink" placeholder="Role" />
                </div>
                {(editable || experience.startDate || experience.endDate) && (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted">
                    <Text editable={editable && !lockExperienceFacts} value={experience.startDate} onCommit={(value) => setExperience(experience.id, { startDate: value })} placeholder="Start" />
                    <span>–</span>
                    <Text editable={editable && !lockExperienceFacts} value={experience.endDate} onCommit={(value) => setExperience(experience.id, { endDate: value })} placeholder="End" />
                  </span>
                )}
              </div>
              {(onRegenerate || editable) && (
                // Controls live in the right gutter (absolute) so they never push
                // the date text left — the canvas stays WYSIWYG with the export.
                <span className="cv-control absolute -right-12 top-0 inline-flex items-center gap-0.5">
                  {onRegenerate && (
                    <button type="button" disabled={busy} onClick={() => onRegenerate("experience", experience.id)}
                      className="inline-flex items-center rounded-md px-1 py-0.5 text-emerald hover:bg-mint disabled:opacity-40" aria-label="Regenerate role">
                      <RefreshCw size={11} />
                    </button>
                  )}
                  {editable && (
                    <button type="button" onClick={() => removeExperience(experience.id)}
                      className="inline-flex items-center rounded-md px-1 py-0.5 text-muted hover:text-red-500" aria-label="Remove role">
                      <X size={12} />
                    </button>
                  )}
                </span>
              )}
              {(editable || experience.company) && (
                <Text editable={editable && !lockExperienceFacts} value={experience.company} onCommit={(value) => setExperience(experience.id, { company: value })}
                  tag="p" className="text-[12px] font-medium text-emerald" placeholder="Company" />
              )}
              {(editable || experience.bullets.filter(Boolean).length > 0) && (
                <div className="mt-1">
                  <EditList items={editable ? experience.bullets : experience.bullets.filter(Boolean)} editable={editable}
                    onChange={(next) => setBullets(experience.id, next)} addLabel="Add bullet" placeholder="Describe an achievement…" />
                </div>
              )}
            </div>
          ))}
          {editable && (
            <button type="button" onClick={addExperience}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald hover:underline">
              <Plus size={12} /> Add role
            </button>
          )}
        </div>
      </Section>
    ) : null,

    skills: (editable || categories.some(([, entries]) => entries.filter(Boolean).length > 0)) ? (
      <Section title="Skills" onRegenerate={onRegenerate && (() => onRegenerate("skills"))} busy={busy} {...moveProps("skills")}>
        <div className="space-y-1">
          {categories.map(([name, entries], index) => {
            if (!editable && !entries.filter(Boolean).length) return null;
            const renameCategory = (value: string) => writeCategories(categories.map((cat, i) => (i === index ? [value, cat[1]] : cat)));
            const editEntries = (value: string) =>
              writeCategories(categories.map((cat, i) => (i === index ? [cat[0], value.split(",").map((s) => s.trim()).filter(Boolean)] : cat)));
            const removeCategory = () => writeCategories(categories.filter((_, i) => i !== index));
            const moveCategory = (to: number) => {
              if (to < 0 || to >= categories.length) return;
              const next = categories.map((cat) => [...cat] as [string, string[]]);
              [next[index], next[to]] = [next[to]!, next[index]!];
              writeCategories(next);
            };
            return (
              <p data-cvblock="block" className="group/row relative flex flex-wrap items-baseline gap-x-1" key={index}>
                <span className="font-semibold text-ink">
                  <Text editable={editable} value={name} onCommit={renameCategory} className="font-semibold text-ink" placeholder="Category" />
                  <span>:</span>
                </span>
                <Text editable={editable} value={entries.join(", ")} onCommit={editEntries} className="flex-1" placeholder="Comma-separated skills" />
                {editable && (
                  <span className="cv-control absolute -right-14 top-0 inline-flex items-center gap-0.5">
                    <button type="button" onClick={() => moveCategory(index - 1)} disabled={index === 0}
                      className="text-muted hover:text-emerald disabled:opacity-25" aria-label="Move skill group up">
                      <ChevronUp size={12} />
                    </button>
                    <button type="button" onClick={() => moveCategory(index + 1)} disabled={index === categories.length - 1}
                      className="text-muted hover:text-emerald disabled:opacity-25" aria-label="Move skill group down">
                      <ChevronDown size={12} />
                    </button>
                    <button type="button" onClick={removeCategory} className="text-muted hover:text-red-500" aria-label="Remove category">
                      <X size={12} />
                    </button>
                  </span>
                )}
              </p>
            );
          })}
          {editable && (
            <button type="button" onClick={() => writeCategories([...categories, ["", []]])}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald hover:underline">
              <Plus size={12} /> Add category
            </button>
          )}
        </div>
      </Section>
    ) : null,

    certifications: certifications.length > 0 ? (
      <Section title="Certifications" contentBlock onRemove={editable ? () => update({ certifications: [] }) : undefined} {...moveProps("certifications")}>
        <EditList items={certifications} editable={editable} onChange={(next) => update({ certifications: next.map((item) => typeof item === "string" ? item : item.text) })} addLabel="Add certification" placeholder="Certification" />
      </Section>
    ) : editable ? (
      <button type="button" onClick={() => update({ certifications: [""] })}
        className="mt-4 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald hover:underline">
        <Plus size={12} /> Add certifications section
      </button>
    ) : null,

    languages: languages.length > 0 ? (
      <Section title="Languages" contentBlock {...moveProps("languages")}>
        {editable ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {cv.languages.map((language, index) => (
              <span className="inline-flex items-center gap-1" key={index}>
                <Editable value={language.language} placeholder="Language"
                  onCommit={(value) => update({ languages: cv.languages.map((item, i) => (i === index ? { ...item, language: value } : item)) })} />
                <span className="text-muted">—</span>
                <Editable value={language.level} placeholder="Level"
                  onCommit={(value) => update({ languages: cv.languages.map((item, i) => (i === index ? { ...item, level: value } : item)) })} />
              </span>
            ))}
          </div>
        ) : (
          <p>{languages.map((language) => [language.language, language.level].filter(Boolean).join(" — ")).join("  ·  ")}</p>
        )}
      </Section>
    ) : null,

    education: (editable || education.length > 0) ? (
      <Section title="Education" {...moveProps("education")}>
        <div className="space-y-2.5">
          {education.map((entry) => editable ? (
            <div data-cvblock="block" className="group/sec relative break-inside-avoid" key={entry.id}>
              <div className="flex items-baseline justify-between gap-3">
                <Text editable value={entry.school} onCommit={(value) => setEducation(entry.id, { school: value })}
                  tag="p" className="font-semibold text-ink" placeholder="School" />
                <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted">
                  <Text editable value={entry.graduationDate} onCommit={(value) => setEducation(entry.id, { graduationDate: value })} placeholder="Graduation date" />
                </span>
              </div>
              <button type="button" onClick={() => removeEducation(entry.id)}
                className="cv-control absolute -right-6 top-0 inline-flex items-center rounded-md px-1 py-0.5 text-muted hover:text-red-500" aria-label="Remove education">
                <X size={12} />
              </button>
              <div className="flex items-baseline justify-between gap-3">
                <Text editable value={entry.degree} onCommit={(value) => setEducation(entry.id, { degree: value })}
                  tag="p" className="text-[12px] font-medium text-emerald" placeholder="Degree & concentration" />
                <Text editable value={entry.location} onCommit={(value) => setEducation(entry.id, { location: value })}
                  className="shrink-0 text-[11px] text-muted" placeholder="Location" />
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 text-[11.5px] text-muted">
                <span className="inline-flex items-baseline gap-1">GPA <Text editable value={entry.gpa} onCommit={(value) => setEducation(entry.id, { gpa: value })} placeholder="—" /></span>
                <Text editable value={entry.honors} onCommit={(value) => setEducation(entry.id, { honors: value })} placeholder="Honors / distinctions" />
              </div>
              <div className="mt-1">
                <EditList items={entry.coursework} editable onChange={(next) => setEducation(entry.id, { coursework: next.map((item) => typeof item === "string" ? item : item.text) })} addLabel="Add coursework" placeholder="Relevant coursework or activity" />
              </div>
            </div>
          ) : (() => {
            const fmt = formatEducationEntry(entry);
            return <div data-cvblock="block" className="break-inside-avoid" key={entry.id}>
              {(fmt.title || fmt.meta) && <div className="flex items-baseline justify-between gap-3">
                <p className="font-semibold text-ink">{fmt.title}</p>
                {fmt.meta && <span className="shrink-0 text-[11px] font-medium text-muted">{fmt.meta}</span>}
              </div>}
              {fmt.subtitle && <p className="text-[12px] text-emerald">{fmt.subtitle}</p>}
              {fmt.bullets.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4 marker:text-emerald">{fmt.bullets.map((line, i) => <li key={i}>{line}</li>)}</ul>}
            </div>;
          })())}
          {editable && (
            <button type="button" onClick={addEducation}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald hover:underline">
              <Plus size={12} /> Add education
            </button>
          )}
        </div>
      </Section>
    ) : null
  };

  return (
    <article ref={pageRef} style={resumeStyleVars(cv.style) as React.CSSProperties} className={editable
      ? "cv-document cv-canvas relative mx-auto w-[794px] max-w-full bg-white px-[96px] py-[96px] font-sans text-ink shadow-soft"
      : "cv-document mx-auto w-[794px] max-w-full bg-white px-[96px] py-[96px] font-sans text-ink shadow-soft"}>
      {editable && pageBreaks.map((top, index) => (
        <div key={index} className="cv-page-guide" style={{ top }}>
          <span className="cv-page-guide-label">Page {index + 2}</span>
        </div>
      ))}
      <header data-cvblock="block" className="group/sec relative border-b-2 border-deep pb-2.5 text-center">
        <Text editable={editable} value={cv.contact.name} onCommit={(value) => setContact("name", value)} placeholder="Your Name"
          tag="h1" className="font-display text-[26px] font-bold leading-tight tracking-tight" />
        {(editable && onCommitHeadline) ? (
          headline ? (
            <span className="mt-0.5 flex items-center justify-center gap-1">
              <Text editable value={headline} onCommit={onCommitHeadline}
                tag="span" className="text-[13px] font-semibold uppercase tracking-[.12em] text-emerald" placeholder="Job title…" />
              <button type="button" onClick={() => onCommitHeadline("")}
                className="cv-control text-muted hover:text-red-500" aria-label="Remove title">
                <X size={11} />
              </button>
            </span>
          ) : (
            // Absolutely positioned so removing the title tightens name→contact spacing.
            // Appears on header hover via cv-control + group/sec.
            <button type="button" onClick={() => onCommitHeadline(" ")}
              className="cv-control absolute left-1/2 top-8 -translate-x-1/2 text-[11px] font-semibold text-muted/60 hover:text-emerald">
              + Add title
            </button>
          )
        ) : headline ? (
          <p className="mt-0.5 text-[13px] font-semibold uppercase tracking-[.12em] text-emerald">{headline}</p>
        ) : null}

        {editable ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
            {CONTACT_FIELDS.map((field) => (
              <span className="inline-flex items-center gap-1.5" key={field.key}>
                <field.icon size={12.5} className="shrink-0 text-emerald" />
                <Editable value={cv.contact[field.key]} onCommit={(value) => setContact(field.key, value)} placeholder={field.placeholder} className="min-w-[3ch]" />
              </span>
            ))}
          </div>
        ) : !!contacts.length && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
            {contacts.map((item) => (
              <span className="inline-flex items-center gap-1.5" key={item.value}>
                <item.icon size={12.5} className="shrink-0 text-emerald" />
                <span className="break-all">{item.value}</span>
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="mt-4">
        {order.map((id) => sections[id] && <Fragment key={id}>{sections[id]}</Fragment>)}
      </div>
    </article>
  );
}
