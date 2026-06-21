import type { JobDescription } from "@cv-tailor/shared";

export type LinkedInScanResult =
  | { status: "ready"; identity: string; job: JobDescription }
  | { status: "loading"; identity: string; reason: string }
  | { status: "unsupported"; identity: string; reason: string };

// Selectors are ordered most-precise first. The trailing `[class*=...]` /
// `[id*=...]` entries are substring-tolerant fallbacks: LinkedIn frequently
// appends hashed modifier suffixes (e.g. `jobs-description__content--AbC12`)
// that break exact class matches, so these keep the scraper reading through a
// redesign even when the precise classes above have churned.
const DESCRIPTION_SELECTORS = [
  '[data-view-name="job-details-description"]',
  // 2025 collections/right-pane rename: the body moved out of
  // `.jobs-description__content` into the "about the job" module.
  ".job-details-about-the-job-module__description",
  ".jobs-description__content .jobs-box__html-content",
  ".jobs-description-content__text",
  ".jobs-box__html-content",
  ".jobs-description__content",
  ".jobs-description__container",
  ".jobs-description",
  "#job-details",
  "[data-job-details]",
  ".description__text .show-more-less-html__markup",
  ".show-more-less-html__markup",
  ".description__text",
  '[class*="jobs-box__html-content"]',
  '[class*="jobs-description-content"]',
  '[class*="jobs-description__content"]',
  '[class*="show-more-less-html__markup"]',
  '[class*="description__text"]',
  '[class*="about-the-job-module__description"]',
  '[class*="about-the-job-module"]',
  '[id*="job-details"]'
];

// English section headings that sit directly above the job body. Used to
// anchor the description on layouts that have dropped every semantic class
// (the 2025 obfuscated `/jobs/view/` rewrite), where the only stable signal
// left is the visible "About the job" heading.
const DESCRIPTION_HEADING = /^(about the job|job description)$/i;

const DETAIL_CONTAINER_SELECTORS = [
  '[data-view-name="job-details"]',
  ".jobs-search__job-details--container",
  ".jobs-details",
  ".jobs-details__main-content",
  ".job-view-layout",
  ".top-card-layout",
  '[class*="jobs-search__job-details"]',
  '[class*="jobs-details__main-content"]',
  '[class*="job-view-layout"]',
  "main"
];

const TITLE_SELECTORS = [
  '[data-view-name="job-details-top-card"] h1',
  ".job-details-jobs-unified-top-card__job-title h1",
  ".job-details-jobs-unified-top-card__job-title",
  ".jobs-details-top-card__job-title",
  ".jobs-unified-top-card__job-title",
  ".top-card-layout__title",
  ".topcard__title",
  '[class*="job-details-jobs-unified-top-card__job-title"]',
  '[class*="jobs-unified-top-card__job-title"]'
];

const COMPANY_SELECTORS = [
  '[data-view-name="job-details-top-card"] a[href*="/company/"]',
  ".job-details-jobs-unified-top-card__company-name a",
  ".job-details-jobs-unified-top-card__company-name",
  ".jobs-details-top-card__company-url",
  ".jobs-unified-top-card__company-name",
  ".topcard__org-name-link",
  '[class*="job-details-jobs-unified-top-card__company-name"] a',
  '[class*="job-details-jobs-unified-top-card__company-name"]',
  '[class*="jobs-unified-top-card__company-name"]'
];

const LOCATION_SELECTORS = [
  '[data-view-name="job-details-top-card"] .tvm__text--low-emphasis',
  ".job-details-jobs-unified-top-card__tertiary-description-container span",
  ".job-details-jobs-unified-top-card__primary-description-container .tvm__text--low-emphasis",
  ".jobs-unified-top-card__bullet",
  ".topcard__flavor--bullet",
  '[class*="job-details-jobs-unified-top-card__tertiary-description-container"] span',
  '[class*="job-details-jobs-unified-top-card__primary-description-container"] [class*="tvm__text--low-emphasis"]'
];

const clean = (value = "") => value.replace(/\s+/g, " ").trim();

function attribute(node: unknown, name: string) {
  return typeof (node as Element | null)?.getAttribute === "function"
    ? (node as Element).getAttribute(name) || ""
    : "";
}

// In a real browser LinkedIn hides stale SPA panels with CSS classes, not
// inline styles, so inspecting `style`/attributes alone lets a longer stale
// description win. When layout-aware APIs exist (they don't under linkedom in
// tests), trust them; otherwise fall back to the inline-style heuristic below.
function hiddenByLayout(node: Element): boolean {
  const anyNode = node as unknown as {
    checkVisibility?: (options?: Record<string, boolean>) => boolean;
    offsetParent?: Element | null;
  };
  try {
    if (typeof anyNode.checkVisibility === "function") {
      return !anyNode.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const view = node.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === "function") {
      const computed = view.getComputedStyle(node);
      if (computed.display === "none" || computed.visibility === "hidden") return true;
      // offsetParent is null for display:none subtrees (position:fixed aside).
      if ("offsetParent" in anyNode && anyNode.offsetParent == null && computed.position !== "fixed") return true;
    }
  } catch {
    // Layout APIs are unavailable or threw; defer to the inline-style heuristic.
  }
  return false;
}

function isVisible(node: Element) {
  if (node.hasAttribute?.("hidden") || attribute(node, "aria-hidden") === "true") return false;
  if (hiddenByLayout(node)) return false;
  const style = attribute(node, "style").replace(/\s+/g, "").toLowerCase();
  if (style.includes("display:none") || style.includes("visibility:hidden") || style.includes("opacity:0")) return false;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.hasAttribute?.("hidden") || attribute(parent, "aria-hidden") === "true") return false;
    const parentStyle = attribute(parent, "style").replace(/\s+/g, "").toLowerCase();
    if (parentStyle.includes("display:none") || parentStyle.includes("visibility:hidden")) return false;
  }
  return true;
}

function candidates(selectors: string[], root: ParentNode) {
  const seen = new Set<Element>();
  const values: Array<{ node: Element; value: string }> = [];
  for (const selector of selectors) {
    let matches = root.querySelectorAll
      ? Array.from(root.querySelectorAll(selector))
      : root.querySelector?.(selector) ? [root.querySelector(selector)!] : [];
    if (!matches.length && root.querySelector?.(selector)) matches = [root.querySelector(selector)!];
    for (const node of matches) {
      if (seen.has(node) || !isVisible(node)) continue;
      seen.add(node);
      const value = clean(node.textContent || "");
      if (value) values.push({ node, value });
    }
  }
  return values;
}

function strongestText(selectors: string[], root: ParentNode, minimumLength = 1) {
  return candidates(selectors, root)
    .filter(({ value }) => value.length >= minimumLength)
    .sort((a, b) => b.value.length - a.value.length)[0];
}

function nearestDetailContainer(node: Element) {
  return node.closest?.(DETAIL_CONTAINER_SELECTORS.join(",")) || null;
}

// Last-resort, layout-agnostic description finder: within a job-detail
// container, return the tightest wrapper around the largest visible text block
// (an element no child of which holds nearly all of its text). This survives a
// full LinkedIn redesign where none of the known description classes match.
function densestTextBlock(root: ParentNode, minimumLength = 200) {
  const container = root.querySelector?.(DETAIL_CONTAINER_SELECTORS.join(",")) || root;
  const elements = Array.from((container as ParentNode).querySelectorAll?.("*") || []);
  let best: { node: Element; value: string } | undefined;
  for (const node of elements) {
    if (!isVisible(node)) continue;
    const value = clean(node.textContent || "");
    if (value.length < minimumLength) continue;
    const childMax = Array.from(node.children).reduce(
      (max, child) => Math.max(max, clean(child.textContent || "").length),
      0
    );
    // Skip outer wrappers: a child is itself a valid (tighter) candidate, so
    // descend to it rather than dragging in surrounding title/company text.
    if (childMax >= minimumLength) continue;
    // Skip navigation/menus (e.g. the footer language picker): real job copy
    // is mostly prose, whereas chrome is almost entirely link text.
    const linkText = Array.from(node.querySelectorAll?.("a") || [])
      .reduce((sum, link) => sum + clean(link.textContent || "").length, 0);
    if (linkText > value.length * 0.5) continue;
    if (!best || value.length > best.value.length) best = { node, value };
  }
  return best;
}

function preferredText(selectors: string[], activeRoot: ParentNode | null, root: ParentNode) {
  return (activeRoot && strongestText(selectors, activeRoot)?.value)
    || strongestText(selectors, root)?.value
    || "";
}

// Find the description by its visible "About the job" heading, then return the
// nearest ancestor that wraps a substantial body of text (heading stripped).
// This is the reliable anchor on the obfuscated `/jobs/view/` rewrite, which
// has no semantic classes, no <h1>, and no JSON-LD — only the heading text.
function descriptionByHeading(root: ParentNode, minimumLength = 40) {
  const headings = Array.from(root.querySelectorAll?.("h1, h2, h3, h4") || []);
  const heading = headings.find((node) => DESCRIPTION_HEADING.test(clean(node.textContent || "")));
  if (!heading || !isVisible(heading)) return undefined;
  const headingText = clean(heading.textContent || "");
  for (let node = heading.parentElement; node; node = node.parentElement) {
    if (!isVisible(node)) break;
    const body = clean((node.textContent || "").replace(headingText, ""));
    if (body.length >= minimumLength) return { node, value: body };
  }
  return undefined;
}

// LinkedIn's `/jobs/view/` rewrite drops every semantic class for the top card
// but still sets a precise document title: "<job> | <company> | LinkedIn"
// (sometimes prefixed with an unread-count "(3) "). Parse it as the last-resort
// source for title and company.
function fromDocumentTitle(root: ParentNode) {
  const raw = clean(root.querySelector?.("title")?.textContent || "");
  const segments = raw
    .replace(/^\(\d+\)\s*/, "")
    .split("|")
    .map((segment) => clean(segment))
    .filter((segment) => segment && !/^linkedin$/i.test(segment));
  return { title: segments[0] || "", company: segments[1] || "" };
}

// LinkedIn embeds full structured job data in <code id="bpr-guid-*"> elements as JSON
// (Bootstrap Payload Response). This is available immediately on page load — before the
// SPA renders any DOM panels — making it far more reliable than CSS selector scraping.
function jobPostingFromBpr(root: ParentNode, url: string): {
  title: string;
  description: string;
  company: string;
  location: string;
} | null {
  const jobId = jobIdFromUrl(url);
  const blocks = Array.from(root.querySelectorAll?.('code[id^="bpr-guid-"]') || []);
  for (const block of blocks) {
    try {
      const data = JSON.parse(block.textContent || "");
      const included: unknown[] = Array.isArray(data?.included) ? data.included : [];
      for (const entry of included) {
        const e = entry as Record<string, unknown>;
        if (e?.["$type"] !== "com.linkedin.voyager.dash.jobs.JobPosting") continue;
        const urn = typeof e.entityUrn === "string" ? e.entityUrn : "";
        if (jobId && !urn.includes(jobId)) continue;

        const descObj = e.description as Record<string, unknown> | undefined;
        const rawDesc = typeof descObj === "string"
          ? descObj
          : typeof descObj?.text === "string" ? descObj.text : "";
        const description = clean(rawDesc.replace(/<[^>]+>/g, " "));
        if (!description) continue;

        const companyEntity = included.find(
          (i) => (i as Record<string, unknown>)?.["$type"] === "com.linkedin.voyager.dash.organization.Company"
        ) as Record<string, unknown> | undefined;
        const companyDetails = e.companyDetails as Record<string, unknown> | undefined;
        const company = typeof companyEntity?.name === "string"
          ? companyEntity.name
          : typeof companyDetails?.name === "string" ? companyDetails.name : "";

        const geoEntity = included.find(
          (i) => (i as Record<string, unknown>)?.["$type"] === "com.linkedin.voyager.dash.common.Geo"
        ) as Record<string, unknown> | undefined;
        const location = typeof geoEntity?.defaultLocalizedName === "string"
          ? geoEntity.defaultLocalizedName : "";

        return {
          title: clean(typeof e.title === "string" ? e.title : ""),
          description,
          company: clean(company),
          location: clean(location)
        };
      }
    } catch {
      // Skip malformed blobs
    }
  }
  return null;
}

function jobPostingFromJsonLd(root: ParentNode) {
  const scripts = Array.from(root.querySelectorAll?.('script[type="application/ld+json"]') || []);
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script.textContent || "");
      const entries = Array.isArray(parsed) ? parsed : parsed["@graph"] || [parsed];
      const posting = entries.find((entry: Record<string, unknown>) => entry?.["@type"] === "JobPosting");
      if (posting) return posting as Record<string, unknown>;
    } catch {
      // LinkedIn may include unrelated or temporarily incomplete JSON-LD.
    }
  }
  return null;
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return clean(value.replace(/<[^>]+>/g, " "));
  return "";
}

function jobIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("currentJobId")
      || parsed.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/)?.[1]
      || "";
  } catch {
    return "";
  }
}

export function linkedInJobId(url: string, root?: ParentNode): string {
  const direct = jobIdFromUrl(url);
  if (direct) return direct;
  if (!root) return "";

  const canonical = root.querySelector?.('link[rel="canonical"]') || root.querySelector?.('meta[property="og:url"]');
  const canonicalId = jobIdFromUrl(attribute(canonical, "href") || attribute(canonical, "content"));
  if (canonicalId) return canonicalId;

  const decorated = root.querySelector?.("#decoratedJobPostingId");
  const decoratedText = `${decorated?.textContent || ""} ${(decorated as Element | null)?.innerHTML || ""}`;
  return clean(decoratedText).match(/\d{6,}/)?.[0] || "";
}

export function isLinkedInJobListing(url: string, root?: ParentNode): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("linkedin.com")
      && parsed.pathname.startsWith("/jobs/")
      && Boolean(linkedInJobId(url, root));
  } catch {
    return false;
  }
}

export function hasLinkedInJobContext(root: ParentNode = document, url = location.href): boolean {
  if (isLinkedInJobListing(url, root)) return true;
  return Boolean(strongestText([...TITLE_SELECTORS, ...DESCRIPTION_SELECTORS], root));
}

export function scrapeLinkedIn(root: ParentNode = document, url = location.href): JobDescription | null {
  // Try BPR first: LinkedIn embeds structured job data synchronously before SPA renders.
  const bpr = jobPostingFromBpr(root, url);
  if (bpr) {
    return { ...bpr, url, source: "linkedin" };
  }

  const jsonLd = jobPostingFromJsonLd(root);
  const descriptionCandidate = strongestText(DESCRIPTION_SELECTORS, root, 40)
    || descriptionByHeading(root)
    || densestTextBlock(root);
  const description = descriptionCandidate?.value || jsonText(jsonLd?.description);
  if (!description) return null;

  const activeRoot = descriptionCandidate ? nearestDetailContainer(descriptionCandidate.node) : null;
  const hiringOrganization = jsonLd?.hiringOrganization as Record<string, unknown> | undefined;
  const jobLocation = jsonLd?.jobLocation as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  const locationEntry = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  const address = locationEntry?.address as Record<string, unknown> | undefined;
  const jsonLocation = [address?.addressLocality, address?.addressRegion, address?.addressCountry]
    .filter((value): value is string => typeof value === "string")
    .join(", ");

  const documentTitle = fromDocumentTitle(root);
  // The new top card bundles posting metadata into the location container
  // ("Makati, Philippines · Reposted 2 weeks ago · 20 applicants"); keep only
  // the leading location segment before the first separator.
  const location = clean((preferredText(LOCATION_SELECTORS, activeRoot, root) || jsonLocation).split("·")[0]);

  return {
    title: preferredText(TITLE_SELECTORS, activeRoot, root) || jsonText(jsonLd?.title) || documentTitle.title,
    company: preferredText(COMPANY_SELECTORS, activeRoot, root) || jsonText(hiringOrganization?.name) || documentTitle.company,
    location,
    description,
    url,
    source: "linkedin"
  };
}

export function scanLinkedIn(root: ParentNode = document, url = location.href, exhausted = false): LinkedInScanResult {
  const identity = linkedInJobId(url, root);
  const job = scrapeLinkedIn(root, url);
  if (job) return { status: "ready", identity, job };
  if (exhausted) {
    return {
      status: "unsupported",
      identity,
      reason: "Fyxor could not read this LinkedIn layout. Highlight the job description and select Send selection to Fyxor."
    };
  }
  return { status: "loading", identity, reason: "Reading LinkedIn job details." };
}
