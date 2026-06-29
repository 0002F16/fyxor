import { describe, expect, it, vi } from "vitest";
import type { BaseProfile, JobDescription } from "@cv-tailor/shared";
import type { Generator } from "./openai";
import { generateUnifiedCv, sanitizeEvidencePlan, validateEvidencePlan, validateWriterOutput } from "./unifiedPipeline";

const profile: BaseProfile = {
  id: "profile-1",
  contact: { name: "Jane Doe", email: "jane@example.com", phone: "", location: "Manila", linkedIn: "" },
  targetRole: "Software Developer",
  summary: "Software developer focused on APIs.",
  experiences: [{
    id: "source-1",
    company: "Acme",
    role: "Software Developer",
    startDate: "2022",
    endDate: "Present",
    bullets: ["Built TypeScript APIs used by 12 internal teams.", "Automated CI deployments."]
  }],
  education: [],
  skills: ["TypeScript", "API Design"],
  skillCategories: { Engineering: ["TypeScript", "API Design"] },
  certifications: [],
  languages: [],
  sectionOrder: [],
  style: { preset: "modern" },
  dismissedChecks: [],
  rawText: "Software Developer at Acme. Built TypeScript APIs used by 12 internal teams.",
  updatedAt: "2026-06-23T00:00:00.000Z"
};

const job: JobDescription = {
  title: "Backend Engineer",
  company: "Target",
  location: "",
  description: "Build TypeScript APIs and reliable backend services.",
  url: "https://example.com/jobs/1",
  source: "manual"
};

const plan = {
  version: "1",
  fit: "direct" as const,
  requirements: [{
    id: "req-1",
    text: "TypeScript APIs",
    priority: "must" as const,
    coverage: "explicit" as const,
    evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
    sourceSkills: ["TypeScript"]
  }],
  summaryClaims: [{
    id: "claim-1",
    objective: "Show backend API experience",
    evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }]
  }],
  roles: [{
    sourceExperienceId: "source-1",
    include: true,
    originalTitle: "Software Developer",
    proposedTitle: "Backend Developer",
    titleEvidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
    titleConfidence: "high" as const,
    bulletObjectives: [{
      id: "objective-1",
      objective: "Show API delivery",
      sourceBulletIndexes: [0],
      requirementIds: ["req-1"]
    }]
  }],
  skills: [{
    skill: "TypeScript",
    category: "Backend Engineering",
    requirementIds: ["req-1"],
    evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
    provenance: "explicit" as const,
    sourceSkills: ["TypeScript"]
  }],
  certifications: [],
  sectionOrder: ["summary", "experience", "skills"],
  pageTarget: "one" as const
};

const writer = {
  summary: "Software developer bringing TypeScript API delivery experience to backend engineering teams.",
  summaryClaims: [{
    id: "claim-1",
    text: "TypeScript API delivery experience",
    evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }]
  }],
  roles: [{
    sourceExperienceId: "source-1",
    displayTitle: "Backend Developer",
    bullets: [{
      id: "bullet-1",
      text: "Built TypeScript APIs used by 12 internal teams.",
      sourceBulletIndexes: [0]
    }]
  }],
  skillCategories: [{ name: "Backend Engineering", skills: ["TypeScript"] }],
  skillEvidence: [{
    skill: "TypeScript",
    evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
    provenance: "explicit" as const,
    sourceSkills: ["TypeScript"],
    requirementIds: ["req-1"]
  }],
  certifications: []
};

const critic = {
  scores: { relevance: 5, credibility: 5, readability: 5, appropriateness: 5 },
  findings: []
};

describe("unified evidence-first pipeline", () => {
  it("uses planner, writer, and critic once and preserves immutable facts", async () => {
    const responses = [plan, writer, critic];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-1", provider: "gemini-api", model: "test-model" });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(cv.contact).toEqual(profile.contact);
    expect(cv.experiences[0]).toMatchObject({
      company: "Acme",
      startDate: "2022",
      endDate: "Present",
      originalRole: "Software Developer",
      role: "Backend Developer",
      titleEvidenceStatus: "verified-reframe"
    });
    expect(cv.experiences[0]?.bullets[0]).toMatchObject({ sourceBulletIndexes: [0], evidenceStatus: "verified" });
    expect(cv.readiness).toBe("ready");
    expect(cv.pipeline.aiCallCount).toBe(3);
  });

  it("uses a conservative plan when the planner returns no usable source roles", async () => {
    const invalid = { ...plan, roles: [{ ...plan.roles[0], sourceExperienceId: "missing" }] };
    const safeWriter = {
      ...writer,
      roles: [{
        sourceExperienceId: "source-1",
        displayTitle: "Software Developer",
        bullets: [{
          id: "source-bullet",
          text: profile.experiences[0]!.bullets[0]!,
          sourceBulletIndexes: [0]
        }]
      }]
    };
    const responses = [invalid, safeWriter, critic];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-2" });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(cv.experiences[0]?.role).toBe("Software Developer");
    expect(cv.pipeline.recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "safe-plan-used", severity: "degraded" })
    ]));
  });

  it("repairs writer output that exceeds approved evidence", async () => {
    const unsafeWriter = {
      ...writer,
      roles: [{ ...writer.roles[0]!, bullets: [{ ...writer.roles[0]!.bullets[0]!, text: "Improved throughput by 40%." }] }]
    };
    const responses = [plan, unsafeWriter, critic, writer];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-3" });
    expect(generate).toHaveBeenCalledTimes(4);
    expect(cv.experiences[0]?.bullets[0]?.text).toContain("12 internal teams");
    expect(cv.pipeline.repairCount).toBe(1);
    expect(cv.readiness).toBe("ready");
  });

  it("detects unplanned writer content deterministically", () => {
    expect(validateEvidencePlan(plan, profile)).toEqual([]);
    expect(validateWriterOutput({
      ...writer,
      skillCategories: [{ name: "Cloud", skills: ["Kubernetes"] }]
    }, plan)).toContain("Writer added unplanned skill Kubernetes");
  });

  it("restores weak title changes and copies every source certification exactly", async () => {
    const certifiedProfile = {
      ...profile,
      certifications: [
        "ACCA F3 Financial Accounting (In Progress)",
        "MS Excel for Finance Specialists",
        "Financial Statements Analysis"
      ]
    };
    const weakPlan = {
      ...plan,
      roles: [{
        ...plan.roles[0],
        proposedTitle: "Engineering Manager",
        titleConfidence: "medium" as const,
        titleEvidence: []
      }],
      certifications: ["Renamed ACCA Certificate"]
    };
    const unsafeWriter = {
      ...writer,
      roles: [{ ...writer.roles[0]!, displayTitle: "Engineering Manager" }],
      certifications: ["Renamed ACCA Certificate"]
    };
    const responses = [weakPlan, unsafeWriter, critic];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({
      generator: { generate },
      profile: certifiedProfile,
      job,
      runId: "run-certifications"
    });

    expect(cv.experiences[0]?.role).toBe("Software Developer");
    expect(cv.certifications).toEqual(certifiedProfile.certifications);
    expect(cv.pipeline.recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "title-reframe-reverted" }),
      expect.objectContaining({ code: "writer-certifications-ignored" })
    ]));
    expect(cv.readiness).toBe("ready");
  });

  it("sanitizes unsupported optional plan content without making it fatal", () => {
    const result = sanitizeEvidencePlan({
      ...plan,
      skills: [
        ...plan.skills,
        { skill: "Kubernetes", category: "Cloud", requirementIds: ["missing"], evidence: [], provenance: "explicit" as const, sourceSkills: [] }
      ],
      summaryClaims: [
        ...plan.summaryClaims,
        { id: "bad-claim", objective: "Unsupported", evidence: [{ sourceExperienceId: "missing", sourceBulletIndexes: [9] }] }
      ]
    }, profile);

    expect(result.plan.skills.map((skill) => skill.skill)).toEqual(["TypeScript", "API Design"]);
    expect(result.plan.summaryClaims.map((claim) => claim.id)).toEqual(["claim-1"]);
    expect(result.recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported-skill-dropped" }),
      expect.objectContaining({ code: "unsupported-summary-claim-dropped" })
    ]));
  });

  it("restores source content when the writer omits roles and returns invalid citations", async () => {
    const invalidWriter = {
      ...writer,
      summary: "",
      summaryClaims: [],
      roles: [{
        sourceExperienceId: "source-1",
        displayTitle: "Chief Technology Officer",
        bullets: [{ id: "bad", text: "Invented claim worth 99%.", sourceBulletIndexes: [99] }]
      }],
      skillCategories: [{ name: "Cloud", skills: ["Kubernetes"] }],
      certifications: ["Invented Certification"]
    };
    const responses = [plan, invalidWriter, critic];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-sanitize-writer" });

    expect(cv.experiences[0]?.role).toBe("Backend Developer");
    expect(cv.experiences[0]?.bullets[0]?.text).toBe(profile.experiences[0]?.bullets[0]);
    expect(cv.skills).toEqual(["TypeScript", "API Design"]);
    expect(cv.summary).toContain("12 internal teams");
    expect(cv.readiness).toBe("ready");
  });

  it("returns a completed blocked CV when the base profile has no experience evidence", async () => {
    const emptyProfile = { ...profile, experiences: [], summary: "", rawText: "" };
    const emptyPlan = { ...plan, summaryClaims: [], roles: [], skills: [], certifications: [] };
    const emptyWriter = { ...writer, summary: "", summaryClaims: [], roles: [], skillCategories: [], skillEvidence: [], certifications: [] };
    const responses = [emptyPlan, emptyWriter, critic, emptyWriter];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({ generator: { generate }, profile: emptyProfile, job, runId: "run-empty" });

    expect(cv.experiences).toEqual([]);
    expect(cv.readiness).toBe("blocked");
    expect(cv.evaluation?.hardFailureIds).toContain("ats-role-structure");
  });

  it("preserves broad accounting evidence when the planner under-selects skills and bullets", async () => {
    const accountingProfile: BaseProfile = {
      ...profile,
      id: "accounting-profile",
      targetRole: "Financial Analyst",
      experiences: [{
        id: "finance-role",
        company: "Capgemini",
        role: "Finance and Accounting Associate",
        startDate: "Mar 2025",
        endDate: "Present",
        bullets: [
          "Recovered up to $20,000 monthly in disputed invoice value and reconciled account statements in SAP.",
          "Managed the Turkey market during a team shortage and cleared a billing backlog.",
          "Owned end-to-end dispute resolution for two global key accounts.",
          "Delivered monthly SOX Self-Assessment reviews, restructured SAP reports in Excel, and audited 6 high-value cases for audit readiness.",
          "Rebuilt a 100-page process guide in 3 weeks, improving departmental productivity.",
          "Trained new team members and reduced onboarding time by 30%."
        ]
      }],
      skills: [
        "Financial Reporting", "Variance Analysis", "Month-End Close", "Account Reconciliation",
        "Multi-Entity Reconciliation", "Financial Statement Analysis", "General Ledger Accounting",
        "Journal Entries", "Accruals & Prepayments", "SOX Compliance", "Internal Controls",
        "IFRS", "Audit Support", "Data Accuracy & Integrity", "Accounts Receivable & Payable",
        "SAP", "SAP Report Extraction", "Advanced Excel", "Macros", "Power Query",
        "Pivot Tables", "VLOOKUP", "Mainframe", "SharePoint"
      ],
      skillCategories: {
        "Financial Analysis & Reporting": [
          "Financial Reporting", "Variance Analysis", "Month-End Close", "Account Reconciliation",
          "Multi-Entity Reconciliation", "Financial Statement Analysis", "General Ledger Accounting",
          "Journal Entries", "Accruals & Prepayments"
        ],
        "Compliance & Controls": ["SOX Compliance", "Internal Controls", "IFRS", "Audit Support", "Data Accuracy & Integrity"],
        "Tools & Systems": ["SAP", "SAP Report Extraction", "Advanced Excel", "Macros", "Power Query", "Pivot Tables", "VLOOKUP", "Mainframe", "SharePoint"],
        "Transactional Operations": ["Accounts Receivable & Payable"]
      },
      certifications: [
        "ACCA F3 Financial Accounting (In Progress — Expected Jun 2026)",
        "MS Excel for Finance Specialists (Udemy)",
        "Financial Statements Analysis (LinkedIn Learning)"
      ],
      languages: [
        { language: "Azerbaijani", level: "Native" },
        { language: "English", level: "B2" }
      ],
      rawText: "Financial reporting, SOX, SAP and Advanced Excel experience with Power Query, Pivot Tables, VLOOKUP and Macros."
    };
    const accountingJob: JobDescription = {
      ...job,
      title: "Financial Accountant",
      description: "Prepare month-end journals, balance sheet reconciliations and financial reporting. Support audit and internal controls, improve financial processes, use advanced Microsoft Excel, communicate with stakeholders, process payroll and support tax compliance."
    };
    const sparsePlan = {
      ...plan,
      requirements: [
        { id: "month-end", text: "Month-end journals and balance sheet reconciliations", priority: "must" as const, coverage: "unsupported" as const, evidence: [], sourceSkills: [] },
        { id: "audit", text: "Audit and internal controls", priority: "important" as const, coverage: "unsupported" as const, evidence: [], sourceSkills: [] },
        { id: "excel", text: "Advanced Microsoft Excel", priority: "must" as const, coverage: "unsupported" as const, evidence: [], sourceSkills: [] },
        { id: "payroll", text: "Payroll processing", priority: "must" as const, coverage: "unsupported" as const, evidence: [], sourceSkills: [] },
        { id: "communication", text: "Strong communication", priority: "important" as const, coverage: "unsupported" as const, evidence: [], sourceSkills: [] }
      ],
      summaryClaims: [{
        id: "accounting-claim",
        objective: "Show reconciliation and reporting experience",
        evidence: [{ sourceExperienceId: "finance-role", sourceBulletIndexes: [0] }]
      }],
      roles: [{
        sourceExperienceId: "finance-role",
        include: true,
        originalTitle: "Finance and Accounting Associate",
        proposedTitle: "Finance and Accounting Associate",
        titleEvidence: [],
        titleConfidence: "high" as const,
        bulletObjectives: [0, 1, 2].map((index) => ({
          id: `sparse-${index}`,
          objective: "Use selected evidence",
          sourceBulletIndexes: [index],
          requirementIds: []
        }))
      }],
      skills: [
        { skill: "Financial Reporting", category: "Financial Management", requirementIds: [], evidence: [], provenance: "explicit" as const, sourceSkills: ["Financial Reporting"] },
        { skill: "Account Reconciliation", category: "Financial Management", requirementIds: [], evidence: [], provenance: "explicit" as const, sourceSkills: ["Account Reconciliation"] }
      ],
      certifications: accountingProfile.certifications,
      sectionOrder: [],
      pageTarget: "one" as const
    };
    const sparseWriter = {
      summary: "Finance professional with reporting and reconciliation experience.",
      summaryClaims: [{
        id: "accounting-claim",
        text: "Reporting and reconciliation experience",
        evidence: [{ sourceExperienceId: "finance-role", sourceBulletIndexes: [0] }]
      }],
      roles: [{
        sourceExperienceId: "finance-role",
        displayTitle: "Finance and Accounting Associate",
        bullets: [0, 1, 2].map((index) => ({
          id: `written-${index}`,
          text: accountingProfile.experiences[0]!.bullets[index]!,
          sourceBulletIndexes: [index]
        }))
      }],
      skillCategories: [{ name: "Financial Management", skills: ["Financial Reporting", "Account Reconciliation"] }],
      skillEvidence: [],
      certifications: []
    };
    const responses = [sparsePlan, sparseWriter, critic];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({
      generator: { generate },
      profile: accountingProfile,
      job: accountingJob,
      runId: "accounting-run"
    });

    expect(cv.experiences[0]!.bullets.length).toBeGreaterThanOrEqual(4);
    expect(cv.experiences[0]!.bullets.some((bullet) => bullet.text.includes("SOX Self-Assessment"))).toBe(true);
    expect(cv.skills.length).toBeGreaterThanOrEqual(8);
    expect(cv.skills).toEqual(expect.arrayContaining([
      "Financial Reporting", "Month-End Close", "Account Reconciliation", "Internal Controls",
      "Audit Support", "SAP", "SAP Report Extraction", "Advanced Excel", "Macros",
      "Power Query", "Pivot Tables", "VLOOKUP"
    ]));
    expect(cv.skills).not.toContain("Payroll");
    expect(cv.skills).not.toContain("Tax Compliance");
    expect(cv.certifications).toEqual(accountingProfile.certifications);
    expect(cv.languages).toEqual(accountingProfile.languages);
    expect(cv.sectionOrder.slice(0, 3)).toEqual(["summary", "experience", "skills"]);
    expect(cv.evidencePlan?.pageTarget).toBe("one");
    expect(cv.skillEvidence.find((skill) => skill.skill === "Communication")).toMatchObject({
      provenance: "inferred-baseline",
      evidenceStatus: "needs-review"
    });
    expect(cv.readiness).toBe("ready");
  });

  it("uses two pages only for a senior profile with enough evidence", () => {
    const seniorProfile: BaseProfile = {
      ...profile,
      positioning: { level: "Senior", strategy: "", notes: "" },
      experiences: [{
        ...profile.experiences[0]!,
        role: "Senior Software Developer",
        bullets: Array.from({ length: 10 }, (_, index) => `Delivered supported backend improvement ${index + 1}.`)
      }]
    };
    const seniorResult = sanitizeEvidencePlan({
      ...plan,
      roles: [{
        ...plan.roles[0]!,
        originalTitle: "Senior Software Developer",
        proposedTitle: "Senior Software Developer"
      }]
    }, seniorProfile, job);
    expect(seniorResult.plan.pageTarget).toBe("two");
    expect(sanitizeEvidencePlan(plan, profile, job).plan.pageTarget).toBe("one");
  });

  it("removes inferred baseline wording from summary and bullets while retaining it in skills", async () => {
    const communicationJob = {
      ...job,
      description: `${job.description} Strong communication is required.`
    };
    const inferredPlan = {
      ...plan,
      requirements: [
        ...plan.requirements,
        {
          id: "communication",
          text: "Strong communication",
          priority: "important" as const,
          coverage: "inferred-baseline" as const,
          evidence: [],
          sourceSkills: []
        }
      ],
      skills: [
        ...plan.skills,
        {
          skill: "Communication",
          category: "Professional Skills",
          requirementIds: ["communication"],
          evidence: [],
          provenance: "inferred-baseline" as const,
          sourceSkills: []
        }
      ]
    };
    const leakingWriter = {
      ...writer,
      summary: "Software developer with strong Communication and TypeScript experience.",
      roles: [{
        ...writer.roles[0]!,
        bullets: [{
          ...writer.roles[0]!.bullets[0]!,
          text: "Used Communication to build TypeScript APIs used by 12 internal teams."
        }]
      }],
      skillCategories: [{ name: "Professional Skills", skills: ["Communication", "TypeScript"] }],
      skillEvidence: []
    };
    const responses = [inferredPlan, leakingWriter, critic];
    const generate = vi.fn(async () => responses.shift()) as unknown as Generator["generate"];
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job: communicationJob, runId: "inferred-scope" });

    expect(cv.skills).toContain("Communication");
    expect(cv.summary).not.toContain("Communication");
    expect(cv.experiences[0]?.bullets.some((bullet) => bullet.text.includes("Communication"))).toBe(false);
    expect(cv.readiness).toBe("ready");
  });

  it("creates a mandatory summary claim for an explicitly required profile language", () => {
    const languageProfile: BaseProfile = {
      ...profile,
      languages: [{ language: "Turkish", level: "C1" }]
    };
    const languageJob: JobDescription = {
      ...job,
      title: "Turkish-speaking Order Management Analyst",
      description: "Manage SAP order workflows and communicate with Turkish customers. Turkish C1 is required."
    };
    const result = sanitizeEvidencePlan(plan, languageProfile, languageJob);
    const requirement = result.plan.requirements.find((entry) => entry.type === "language");
    expect(requirement).toMatchObject({ priority: "must", coverage: "explicit", summaryValue: 5 });
    expect(result.plan.summaryClaims.some((claim) =>
      claim.mandatory && (claim.requirementIds || []).includes(requirement!.id)
    )).toBe(true);
    expect(result.plan.summaryBlueprint?.decisiveRequirementIds).toContain(requirement!.id);
  });

  it("rejects a reused generic summary when the target blueprint requires different positioning", () => {
    const result = sanitizeEvidencePlan({
      ...plan,
      fit: "adjacent",
      fitDimensions: {
        functionFit: "change",
        industryFit: "unknown",
        seniorityFit: "matched",
        evidenceStrength: "partial"
      },
      summaryBlueprint: {
        positioningMode: "transition",
        positioningStrategy: "Frame a transition into compliance.",
        targetIdentityAllowed: false,
        decisiveRequirementIds: [],
        claimIds: ["claim-1"]
      }
    }, profile, { ...job, title: "KYC Analyst" });
    const findings = validateWriterOutput({
      ...writer,
      summary: profile.summary,
      summaryClaims: [{
        ...writer.summaryClaims[0]!,
        text: profile.summary
      }]
    }, result.plan, profile, { ...job, title: "KYC Analyst" });
    expect(findings).toContain("Writer reused the generic base summary despite job-specific summary evidence");
  });
});
