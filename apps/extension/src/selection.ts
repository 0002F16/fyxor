import type { JobDescription } from "@cv-tailor/shared";

// Generic LinkedIn feed/collection tab titles that must never become the job
// title — they describe a list of jobs, not a posting. Seen as "<phrase> | LinkedIn".
const GENERIC_FEED_TITLE = /^(jobs where you|top job picks|recommended for you|more jobs for you|jobs you may be interested|your job alerts|saved jobs|job collections)/i;
// LinkedIn surfaces that list many jobs rather than a single posting.
const FEED_PATH = /\/(jobs\/(collections|search)|feed)\b/i;

// UI chrome that gets swept up when a user drags across a job posting. These are
// never the job title or employer, so they're skipped while scanning the body.
const NOISE_LINE = /^(share|show more options?|save|apply|easy apply|promoted by hirer|see more|about the job|more options?|sign in)$/i;
// A line that reads like LinkedIn's metadata row, e.g.
// "Taguig, National Capital Region, Philippines · 2 weeks ago · 94 people clicked apply".
const POSTED_AGO = /\b\d+\s+(?:week|day|hour|month|year|minute)s?\s+ago\b/i;

// Parse a job title + employer straight out of the selected text. LinkedIn (and
// most job boards) render the employer as "<Company> logo" followed by the bare
// company name, then the role title above a location/metadata row. We anchor on
// those landmarks and stay conservative: an empty value beats a wrong one, since
// the dialog/popup let the user fix it before tailoring.
export function parseJobFromText(selectionText: string): { title: string; company: string; location: string } {
  const lines = selectionText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let company = "";
  for (const line of lines) {
    const match = line.match(/^(.+?)\s+logo$/i);
    if (match?.[1]) { company = match[1].trim(); break; }
  }

  const isNoise = (line: string) =>
    NOISE_LINE.test(line) ||
    line.toLowerCase() === company.toLowerCase() ||
    line.toLowerCase() === `${company.toLowerCase()} logo`;

  // The metadata row anchors the title: the role sits on the nearest non-noise
  // line above it.
  const metaIndex = lines.findIndex((line) => line.includes(" · ") || POSTED_AGO.test(line));
  let title = "";
  let location = "";
  if (metaIndex !== -1) {
    for (let i = metaIndex - 1; i >= 0; i -= 1) {
      const candidate = lines[i] ?? "";
      if (!isNoise(candidate)) { title = candidate; break; }
    }
    // The leading geographic chunk of the metadata row, when it has one.
    const head = (lines[metaIndex] ?? "").split(" · ")[0]?.trim() ?? "";
    if (head.includes(",") && !POSTED_AGO.test(head)) location = head;
  }
  // Fallback: LinkedIn's title is the first real line after "Show more options".
  if (!title) {
    const optionsIndex = lines.findIndex((line) => /^show more options?$/i.test(line));
    if (optionsIndex !== -1) {
      const next = lines.slice(optionsIndex + 1).find((line) => !isNoise(line));
      if (next) title = next;
    }
  }
  if (GENERIC_FEED_TITLE.test(title)) title = "";

  return { title, company, location };
}

export function jobFromSelection(selectionText: string, pageUrl: string, pageTitle = ""): JobDescription {
  let company = "";
  let isFeedPath = false;
  try {
    const url = new URL(pageUrl);
    company = url.hostname.replace(/^www\./, "");
    isFeedPath = FEED_PATH.test(url.pathname);
  } catch {
    company = "";
  }
  // Document titles read "<job> | <company> | LinkedIn" (optionally prefixed
  // with an unread count). Take the first meaningful segment as the job title,
  // mirroring the scraper's fromDocumentTitle.
  const firstSegment = pageTitle
    .replace(/^\(\d+\)\s*/, "")
    .split("|")
    .map((segment) => segment.trim())
    .find((segment) => segment && !/^linkedin$/i.test(segment)) || "";
  // An empty title is better than a wrong one: the dialog lets the user type it.
  const titleFromTab = isFeedPath || GENERIC_FEED_TITLE.test(firstSegment) ? "" : firstSegment;
  // The selected text itself is usually the richest source — prefer values parsed
  // from it, falling back to the tab title / hostname when the body yields nothing.
  const parsed = parseJobFromText(selectionText);
  return {
    title: parsed.title || titleFromTab,
    company: parsed.company || company,
    location: parsed.location,
    description: selectionText.trim(),
    url: pageUrl,
    source: "manual"
  };
}
