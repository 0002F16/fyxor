import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { hasLinkedInJobContext, isLinkedInJobListing, linkedInJobId, scanLinkedIn, scrapeLinkedIn } from "./scraper";

function fixture(name: string) {
  return parseHTML(readFileSync(`apps/extension/src/fixtures/${name}`, "utf8")).document;
}

describe("LinkedIn scraper", () => {
  it("returns null when no job description exists", () => {
    const root = { querySelector: () => null } as unknown as ParentNode;
    expect(scrapeLinkedIn(root, "https://linkedin.com/jobs/view/1")).toBeNull();
  });

  it("extracts known selectors", () => {
    const values: Record<string, string> = {
      "h1": "Product Manager",
      ".job-details-jobs-unified-top-card__company-name": "Acme",
      ".jobs-description-content__text": "This is a long job description requiring stakeholder management and product delivery."
    };
    const root = { querySelector: (s: string) => values[s] ? { textContent: values[s] } : null } as unknown as ParentNode;
    expect(scrapeLinkedIn(root, "https://linkedin.com/jobs/view/1")?.company).toBe("Acme");
  });

  it("extracts the selected job id from LinkedIn collection URLs", () => {
    expect(linkedInJobId("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4419224693")).toBe("4419224693");
    expect(linkedInJobId("https://www.linkedin.com/jobs/view/4419224693/")).toBe("4419224693");
    expect(linkedInJobId("https://ph.linkedin.com/jobs/view/product-lead-at-example-labs-4419224693")).toBe("4419224693");
  });

  it("recognizes LinkedIn collection and direct job URLs as selected jobs", () => {
    expect(isLinkedInJobListing("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4419224693")).toBe(true);
    expect(isLinkedInJobListing("https://www.linkedin.com/jobs/view/4419224693/")).toBe(true);
    expect(isLinkedInJobListing("https://ph.linkedin.com/jobs/view/product-lead-at-example-labs-4419224693")).toBe(true);
    expect(isLinkedInJobListing("https://www.linkedin.com/jobs/collections/recommended/")).toBe(false);
  });

  it("recognizes a visible LinkedIn detail panel even without currentJobId", () => {
    const root = {
      querySelector: (selector: string) => selector.includes(".jobs-description__content") ? { textContent: "job" } : null
    } as unknown as ParentNode;
    expect(hasLinkedInJobContext(root, "https://www.linkedin.com/jobs/collections/recommended/")).toBe(true);
  });

  it("reads the current collection detail pane", () => {
    const values: Record<string, string> = {
      ".job-details-jobs-unified-top-card__job-title h1": "Senior Product Manager",
      ".job-details-jobs-unified-top-card__company-name a": "Example Labs",
      ".job-details-jobs-unified-top-card__tertiary-description-container span": "Warsaw, Poland",
      ".jobs-description__content .jobs-box__html-content": "Own the product roadmap, lead stakeholder reviews, and work across product and engineering."
    };
    const root = {
      querySelector: (selector: string) => values[selector] ? { textContent: values[selector] } : null,
      querySelectorAll: () => []
    } as unknown as ParentNode;

    expect(scrapeLinkedIn(root, "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4419224693")).toMatchObject({
      title: "Senior Product Manager",
      company: "Example Labs",
      location: "Warsaw, Poland",
      source: "linkedin"
    });
  });

  it("falls back to JobPosting JSON-LD when LinkedIn selectors change", () => {
    const posting = {
      "@type": "JobPosting",
      title: "Platform Lead",
      description: "<p>Lead platform delivery, architecture reviews, and cross-functional execution.</p>",
      hiringOrganization: { name: "Northstar" },
      jobLocation: { address: { addressLocality: "Kraków", addressCountry: "PL" } }
    };
    const root = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === 'script[type="application/ld+json"]'
        ? [{ textContent: JSON.stringify(posting) }]
        : []
    } as unknown as ParentNode;

    expect(scrapeLinkedIn(root, "https://www.linkedin.com/jobs/view/99")).toMatchObject({
      title: "Platform Lead",
      company: "Northstar",
      location: "Kraków, PL",
      description: "Lead platform delivery, architecture reviews, and cross-functional execution."
    });
  });

  it("reads current data-view-name selectors", () => {
    const values: Record<string, string> = {
      '[data-view-name="job-details-top-card"] h1': "Operations Lead",
      '[data-view-name="job-details-top-card"] a[href*="/company/"]': "Northstar",
      '[data-view-name="job-details-description"]': "Lead operations, process improvement, and cross-functional delivery for the business."
    };
    const root = {
      querySelector: (selector: string) => values[selector] ? { textContent: values[selector] } : null,
      querySelectorAll: () => []
    } as unknown as ParentNode;
    expect(scrapeLinkedIn(root, "https://www.linkedin.com/jobs/view/2")).toMatchObject({
      title: "Operations Lead",
      company: "Northstar"
    });
  });

  it("reads the current public LinkedIn layout and canonical identity", () => {
    const document = fixture("linkedin-public-job.html");
    const url = "https://ph.linkedin.com/jobs/";
    expect(linkedInJobId(url, document)).toBe("4419224693");
    expect(scrapeLinkedIn(document, url)).toMatchObject({
      title: "Product Lead",
      company: "Example Labs",
      location: "Makati, Philippines",
      description: expect.stringContaining("Lead product strategy")
    });
  });

  it("falls back to LinkedIn's decorated job posting id", () => {
    const document = parseHTML('<code id="decoratedJobPostingId"><!--"4419224693"--></code>').document;
    expect(linkedInJobId("https://www.linkedin.com/jobs/collections/recommended/", document)).toBe("4419224693");
  });

  it("ignores a longer hidden stale detail panel", () => {
    const document = fixture("linkedin-spa-job.html");
    expect(scrapeLinkedIn(document, "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=99")).toMatchObject({
      title: "Senior Product Manager",
      company: "Current Labs",
      location: "Warsaw, Poland",
      description: expect.stringContaining("active product roadmap")
    });
  });

  it("reads the obfuscated /jobs/view/ rewrite via heading + document title", () => {
    const document = fixture("linkedin-react-job-view.html");
    const url = "https://www.linkedin.com/jobs/view/4409910404";
    expect(linkedInJobId(url, document)).toBe("4409910404");
    const job = scrapeLinkedIn(document, url);
    expect(job).toMatchObject({
      title: "Innovation Program Specialist",
      company: "PJ Lhuillier Group of Companies",
      source: "linkedin"
    });
    expect(job?.description).toContain("innovation program office");
    expect(job?.description).not.toContain("largest conglomerates");
  });

  it("reads the collections detail pane after the description module rename", () => {
    const document = fixture("linkedin-collections-pane.html");
    const job = scrapeLinkedIn(document, "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4402630025");
    expect(job).toMatchObject({
      title: "Top Creators Management Project Intern",
      company: "ByteDance",
      location: "Taguig, National Capital Region, Philippines"
    });
    expect(job?.description).toContain("Top Creator Team partners closely");
    expect(job?.description).not.toContain("stale hidden job description");
    // The generic title must not leak in from document.title on this surface.
    expect(job?.title).not.toBe("Top job picks for you");
  });

  it("reads a redesigned layout via the generic densest-text fallback", () => {
    const document = fixture("linkedin-redesigned-job.html");
    const job = scrapeLinkedIn(document, "https://www.linkedin.com/jobs/view/4409910404");
    expect(job?.description).toContain("Own platform reliability");
    expect(job?.description).not.toContain("stale hidden job description");
  });

  it("reads job data from BPR JSON blobs before the SPA renders any DOM", () => {
    const posting = {
      $type: "com.linkedin.voyager.dash.jobs.JobPosting",
      entityUrn: "urn:li:fsd_jobPosting:4416689347",
      title: "AI Product Manager",
      description: { text: "Lead voicebot product strategy and delivery.\n\nOwn the roadmap end to end.", $type: "com.linkedin.voyager.common.TextViewModel" },
      companyDetails: { name: "Home Credit Philippines" }
    };
    const geo = {
      $type: "com.linkedin.voyager.dash.common.Geo",
      entityUrn: "urn:li:fsd_geo:106837643",
      defaultLocalizedName: "Taguig, National Capital Region, Philippines"
    };
    const bprJson = JSON.stringify({ data: {}, included: [posting, geo] });
    const document = parseHTML(`<html><body><code id="bpr-guid-123">${bprJson}</code></body></html>`).document;

    expect(scrapeLinkedIn(document, "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4416689347")).toMatchObject({
      title: "AI Product Manager",
      company: "Home Credit Philippines",
      location: "Taguig, National Capital Region, Philippines",
      description: expect.stringContaining("Lead voicebot"),
      source: "linkedin"
    });
  });

  it("uses Company entity name from BPR over companyDetails fallback", () => {
    const posting = {
      $type: "com.linkedin.voyager.dash.jobs.JobPosting",
      entityUrn: "urn:li:fsd_jobPosting:999",
      title: "Senior Engineer",
      description: { text: "Design and build scalable distributed systems across the full stack." },
      companyDetails: { name: "Fallback Name" }
    };
    const company = { $type: "com.linkedin.voyager.dash.organization.Company", name: "Canonical Corp", entityUrn: "urn:li:fsd_company:1" };
    const bprJson = JSON.stringify({ data: {}, included: [posting, company] });
    const document = parseHTML(`<html><body><code id="bpr-guid-456">${bprJson}</code></body></html>`).document;

    expect(scrapeLinkedIn(document, "https://www.linkedin.com/jobs/view/999/")?.company).toBe("Canonical Corp");
  });

  it("skips BPR blobs whose job ID does not match the URL", () => {
    const posting = {
      $type: "com.linkedin.voyager.dash.jobs.JobPosting",
      entityUrn: "urn:li:fsd_jobPosting:111",
      title: "Wrong Job",
      description: { text: "This job should not be returned for the requested job ID." }
    };
    const bprJson = JSON.stringify({ data: {}, included: [posting] });
    const root = {
      querySelector: () => null,
      querySelectorAll: (s: string) => s === 'code[id^="bpr-guid-"]'
        ? [{ textContent: bprJson }]
        : []
    } as unknown as ParentNode;

    // URL asks for job 999, BPR has job 111 — should not return BPR result
    expect(scrapeLinkedIn(root, "https://www.linkedin.com/jobs/view/999/")).toBeNull();
  });

  it("returns explicit loading and unsupported scan states", () => {
    const root = { querySelector: () => null, querySelectorAll: () => [] } as unknown as ParentNode;
    expect(scanLinkedIn(root, "https://www.linkedin.com/jobs/view/99", false).status).toBe("loading");
    expect(scanLinkedIn(root, "https://www.linkedin.com/jobs/view/99", true)).toMatchObject({
      status: "unsupported",
      identity: "99"
    });
  });
});
