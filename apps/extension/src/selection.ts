import type { JobDescription } from "@cv-tailor/shared";

// Generic LinkedIn feed/collection tab titles that must never become the job
// title — they describe a list of jobs, not a posting. Seen as "<phrase> | LinkedIn".
const GENERIC_FEED_TITLE = /^(jobs where you|top job picks|recommended for you|more jobs for you|jobs you may be interested|your job alerts|saved jobs|job collections)/i;
// LinkedIn surfaces that list many jobs rather than a single posting.
const FEED_PATH = /\/(jobs\/(collections|search)|feed)\b/i;

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
  const title = isFeedPath || GENERIC_FEED_TITLE.test(firstSegment) ? "" : firstSegment;
  return {
    title,
    company,
    location: "",
    description: selectionText.trim(),
    url: pageUrl,
    source: "manual"
  };
}
