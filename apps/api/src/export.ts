import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopPosition,
  TabStopType,
  TextRun,
  UnderlineType
} from "docx";
import type { Browser } from "puppeteer";
import {
  educationHasContent,
  effectiveSectionOrder,
  formatEducationEntry,
  normalizeSkillCategories,
  type SectionId,
  type TailoredCv
} from "@cv-tailor/shared";
import { renderCvHtml } from "./cvHtml.js";

// ---------------------------------------------------------------------------
// Shared Puppeteer browser — launched lazily and reused across requests so
// successive exports don't pay the Chromium cold-start cost each time.
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const puppeteer = await import("puppeteer");
    browserPromise = puppeteer.default.launch({
      headless: true,
      executablePath: process.env["PUPPETEER_EXECUTABLE_PATH"],
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

export async function makePdf(cv: TailoredCv): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const html = renderCvHtml(cv);
    // All fonts are base64-inlined so networkidle0 is fine even offline.
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// DOCX export — Word can't render HTML so this stays a docx-library mapping,
// but it's been retouched to mirror the on-screen canvas as closely as Word
// allows: centered header with a bottom border, emerald headline, stacked
// role/company, right-aligned dates, emerald-accented bullets, Category —
// entries skills.
// ---------------------------------------------------------------------------

// All sizes below are in half-points (Word's unit); 1pt = 2 units.
const S = {
  name: 34,       // 17pt — canvas name is 26px ≈ 19.5pt; 17pt is a comfortable Word equivalent
  headline: 22,   // 11pt
  contact: 18,    // 9pt
  heading: 22,    // 11pt bold
  meta: 16,       // 8pt
  body: 21,       // 10.5pt
  company: 20,    // 10pt
  label: 17       // 8.5pt small caps section label
};
const EMERALD = "059669";
const DEEP = "065F46";
const INK = "0F172A";
const MUTED = "4B5563";
const FONT = "Plus Jakarta Sans";
const FONT_BODY = "Inter";

type Section = {
  heading: string;
  lines: string[];
  meta?: string;
  categories?: Array<{ name: string; entries: string }>;
};

function cvSections(cv: TailoredCv): Section[] {
  const languageLine = cv.languages
    .map((l) => [l.language, l.level].filter(Boolean).join(" — "))
    .filter(Boolean)
    .join("  ·  ");
  const skillCategories = normalizeSkillCategories(cv.skillCategories, cv.skills)
    .map(([name, entries]) => ({ name, entries: entries.filter(Boolean).join(", ") }))
    .filter((c) => c.entries);
  const byId: Record<SectionId, Section[]> = {
    summary: [{ heading: "Profile", lines: [cv.summary] }],
    experience: cv.experiences.map((exp) => ({
      heading: exp.role,
      lines: exp.bullets,
      meta: [exp.company, [exp.startDate, exp.endDate].filter(Boolean).join(" – ")].filter(Boolean).join("  ·  ")
    })),
    skills: [{ heading: "Skills", lines: [], categories: skillCategories }],
    certifications: cv.certifications.length ? [{ heading: "Certifications", lines: cv.certifications }] : [],
    languages: languageLine ? [{ heading: "Languages", lines: [languageLine] }] : [],
    education: [{
      heading: "Education",
      lines: cv.education.filter(educationHasContent).flatMap((entry, index) => {
        const fmt = formatEducationEntry(entry);
        const block = [
          [fmt.title, fmt.meta].filter(Boolean).join("  ·  "),
          fmt.subtitle,
          fmt.bullets.length ? `Relevant coursework: ${fmt.bullets.join(", ")}` : ""
        ].filter(Boolean);
        return index === 0 ? block : ["", ...block];
      })
    }]
  };
  return effectiveSectionOrder(cv.sectionOrder).flatMap((id) => byId[id]);
}

// A horizontal rule paragraph (simulates a border under headings).
function hrParagraph(): Paragraph {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: DEEP } },
    spacing: { after: 0 }
  });
}

export async function makeDocx(cv: TailoredCv): Promise<Buffer> {
  const children: Paragraph[] = [];

  // ---- Header ----
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: cv.contact.name, bold: true, size: S.name, font: FONT, color: INK })],
    spacing: { after: cv.job?.title ? 60 : 100 }
  }));

  if (cv.job?.title) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: cv.job.title.toUpperCase(),
        bold: true,
        color: EMERALD,
        size: S.headline,
        font: FONT
      })],
      spacing: { after: 100 }
    }));
  }

  const contactParts = [cv.contact.location, cv.contact.phone, cv.contact.email, cv.contact.linkedIn].filter(Boolean);
  if (contactParts.length) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: contactParts.join("  ·  "), size: S.contact, font: FONT_BODY, color: MUTED })],
      spacing: { after: 0 }
    }));
  }
  // Bottom border under header (mirrors border-b-2 border-deep on the canvas)
  children.push(hrParagraph());
  children.push(new Paragraph({ spacing: { after: 160 } }));

  // ---- Sections ----
  for (const section of cvSections(cv)) {
    // Section heading with bottom rule
    children.push(new Paragraph({
      children: [new TextRun({
        text: section.heading.toUpperCase(),
        bold: true,
        color: DEEP,
        size: S.heading,
        font: FONT
      })],
      border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "E6E8EC" } },
      keepNext: true,
      spacing: { before: 200, after: 80 }
    }));

    // Experience sections: meta is "Company  ·  StartDate – EndDate" — split and render separately
    if (section.meta) {
      const [company, dates] = section.meta.split("  ·  ");
      if (company && dates) {
        // Role (bold) + date right-aligned via tab stop
        children.push(new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          children: [
            new TextRun({ text: section.heading, bold: true, size: S.body, font: FONT_BODY, color: INK }),
            new TextRun({ text: "\t" }),
            new TextRun({ text: dates, size: S.meta, font: FONT_BODY, color: MUTED })
          ],
          keepNext: true,
          spacing: { after: 40 }
        }));
        // Company on its own line in emerald (mirrors canvas company row)
        children.push(new Paragraph({
          children: [new TextRun({ text: company, size: S.company, font: FONT_BODY, color: EMERALD })],
          keepNext: section.lines.length > 0,
          spacing: { after: 60 }
        }));
      } else {
        // Fallback: single meta line (education, etc.)
        children.push(new Paragraph({
          children: [new TextRun({ text: section.meta, size: S.meta, font: FONT_BODY, color: MUTED })],
          keepNext: true,
          spacing: { after: 60 }
        }));
      }
    }

    if (section.categories) {
      for (const cat of section.categories) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: cat.name, bold: true, size: S.body, font: FONT_BODY, color: INK }),
            new TextRun({ text: " — " + cat.entries, size: S.body, font: FONT_BODY, color: MUTED })
          ],
          keepLines: true,
          spacing: { after: 60 }
        }));
      }
      continue;
    }

    const isBulleted = section.heading !== "Profile"
      && section.heading !== "Skills"
      && section.heading !== "Languages"
      && section.heading !== "Education";

    for (const line of section.lines) {
      if (!line) {
        children.push(new Paragraph({ spacing: { after: 60 } }));
        continue;
      }
      children.push(new Paragraph({
        text: line,
        bullet: isBulleted ? { level: 0 } : undefined,
        children: !isBulleted ? [new TextRun({ text: line, size: S.body, font: FONT_BODY, color: INK })] : undefined,
        keepLines: true,
        spacing: { after: 60 }
      }));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT_BODY, size: S.body, color: INK } }
      },
      paragraphStyles: [
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          run: { bold: true, color: DEEP, size: S.heading, font: FONT }
        }
      ]
    },
    // 0.5in margins (720 twips) on every side, matching the PDF / canvas.
    sections: [{ properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children }]
  });
  return Packer.toBuffer(doc);
}
