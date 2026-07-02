import { describe, expect, it, vi } from "vitest";
import type { BaseProfile, JobDescription } from "@cv-tailor/shared";
import type { Generator } from "./openai";
import { evidencePlanSchema } from "@cv-tailor/shared";
import { generateUnifiedCv, regenerateUnifiedSection, sanitizeEvidencePlan, validateEvidencePlan, validateWriterOutput } from "./unifiedPipeline";

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

// The writer now runs as three section calls (resume_summary / resume_experience /
// resume_skills). This mock dispatches by the generate() call name so tests stay
// robust to call count and order. A writer-shaped fixture is split into its sections.
function dispatchGenerator(overrides: {
  plan?: unknown;
  writer?: typeof writer | Record<string, any>;
  critic?: unknown;
  repair?: typeof writer | Record<string, any>;
  criticRecheck?: unknown;
} = {}): Generator["generate"] {
  const w = (overrides.writer ?? writer) as Record<string, any>;
  const map: Record<string, unknown> = {
    evidence_plan: overrides.plan ?? plan,
    resume_summary: { summary: w.summary, summaryClaims: w.summaryClaims },
    resume_experience: { roles: w.roles },
    resume_skills: { skillCategories: w.skillCategories },
    resume_critic: overrides.critic ?? critic,
    resume_critic_recheck: overrides.criticRecheck ?? overrides.critic ?? critic,
    resume_repair: overrides.repair ?? w
  };
  return vi.fn(async ({ name }: { name: string }) => map[name]) as unknown as Generator["generate"];
}

describe("unified evidence-first pipeline", () => {
  it("uses planner, writer, and critic once and preserves immutable facts", async () => {
    const generate = dispatchGenerator();
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-1", provider: "gemini-api", model: "test-model" });

    expect(generate).toHaveBeenCalledTimes(5);
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
    expect(cv.pipeline.aiCallCount).toBe(5);
  });

  it("keeps a usable brief LLM summary verbatim without templated prepend or padding", async () => {
    const briefSummary = "Backend Engineer with hands-on TypeScript API delivery experience building reliable backend services for production workloads. Shipped TypeScript APIs used daily by 12 internal teams and kept release pipelines fast and dependable. Brings a proven record of delivering backend services that hold up under real production traffic.";
    const briefWriter = {
      ...writer,
      summary: briefSummary,
      summaryClaims: [{
        id: "claim-1",
        text: "TypeScript API delivery experience",
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }]
      }]
    };
    const generate = dispatchGenerator({ writer: briefWriter });
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-brief" });

    expect(cv.summary).toBe(briefSummary);
    expect(cv.summary).not.toMatch(/transitioning into/i);
    expect(cv.summary).not.toMatch(/focused foundation|verified strengths/i);
    expect(cv.pipeline.recoveries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source-summary-restored" })
    ]));
  });

  it("regenerating the summary uses the shared spec and keeps the new summary verbatim", async () => {
    const briefSummary = "Backend Engineer with hands-on TypeScript API delivery experience building reliable backend services for production workloads. Shipped TypeScript APIs used daily by 12 internal teams and kept release pipelines fast and dependable. Brings a proven record of delivering backend services that hold up under real production traffic.";
    // First produce a unified CV (with an evidencePlan) the regenerate path can operate on.
    const cv = await generateUnifiedCv({ generator: { generate: dispatchGenerator() }, profile, job, runId: "run-regen" });

    let summaryInstruction = "";
    const regenWriter = {
      ...writer,
      summary: briefSummary,
      summaryClaims: [{
        id: "claim-1",
        text: "TypeScript API delivery experience",
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }]
      }]
    };
    const generate = vi.fn(async ({ name, instructions }: { name: string; instructions: string }) => {
      if (name === "regenerate_summary") { summaryInstruction = instructions; return regenWriter; }
      if (name.startsWith("critic")) return critic;
      return regenWriter;
    }) as unknown as Generator["generate"];

    const patch = await regenerateUnifiedSection({ generator: { generate }, profile, cv, section: "summary" });

    // The regenerate summary call carries the same shared spec as a fresh tailor.
    expect(summaryInstruction).toContain("3-4 rendered resume lines");
    expect(summaryInstruction).toContain("40-65");
    expect(summaryInstruction).toContain("transition opener");
    expect(summaryInstruction).toContain("Use \"Aspiring [target role]\" only");
    expect(summaryInstruction).toContain("opening words must immediately show role-relevant value");
    if (patch.section !== "summary") throw new Error("expected a summary patch");
    expect(patch.summary).toBe(briefSummary);
    expect(patch.summary).not.toMatch(/transitioning into/i);
  });

  it("builds compact summary blueprint guidance for an aligned role with supported YoE", () => {
    const result = sanitizeEvidencePlan(plan, profile, {
      ...job,
      description: `${job.description} Three years of backend delivery experience preferred.`
    });

    expect(result.plan.summaryBlueprint).toMatchObject({
      archetype: "aligned",
      targetIdentityAllowed: false
    });
    expect(result.plan.summaryBlueprint?.includeYearsOfExperience?.include).toBe(true);
    expect(result.plan.summaryBlueprint?.includeYearsOfExperience?.years).toBeGreaterThanOrEqual(2);
    expect(result.plan.summaryBlueprint?.mustUseKeywords).toContain("TypeScript");
    expect(result.plan.summaryBlueprint?.proofPoints?.join(" ")).toContain("TypeScript APIs");
  });

  it("uses transition-safe summary guidance for a functional career shift", () => {
    const shiftPlan = {
      ...plan,
      fit: "stretch" as const,
      fitDimensions: { functionFit: "change" as const, industryFit: "unknown" as const, seniorityFit: "unknown" as const, evidenceStrength: "partial" as const },
      requirements: [{
        id: "req-kyc",
        text: "KYC evidence review",
        priority: "must" as const,
        coverage: "supported-equivalent" as const,
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
        summaryEvidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
        sourceSkills: []
      }],
      summaryClaims: [{
        id: "claim-kyc",
        objective: "Show transferable investigation evidence for KYC",
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }],
        requirementIds: ["req-kyc"]
      }]
    };
    const result = sanitizeEvidencePlan(shiftPlan, profile, {
      ...job,
      title: "KYC Analyst",
      description: "Review KYC evidence and investigate risk indicators."
    });

    expect(result.plan.summaryBlueprint?.archetype).toBe("career-shifter");
    expect(result.plan.summaryBlueprint?.targetIdentityAllowed).toBe(false);
    expect(result.plan.summaryBlueprint?.openingFrame).toMatch(/do not claim established KYC Analyst identity/i);
    expect(result.plan.summaryBlueprint?.mustAvoidClaims).toContain("established KYC Analyst identity");
  });

  it("classifies education-led and senior summary archetypes", () => {
    const juniorProfile: BaseProfile = {
      ...profile,
      targetRole: "Data Analyst",
      experiences: [{ ...profile.experiences[0]!, role: "Data Intern" }],
      projects: [{ id: "p1", title: "Dashboard", description: "Built Tableau dashboards.", bullets: ["Cleaned datasets in Python."], technologies: ["Python", "Tableau"] }]
    };
    expect(sanitizeEvidencePlan(plan, juniorProfile, job).plan.summaryBlueprint?.archetype).toBe("junior");

    const seniorProfile: BaseProfile = {
      ...profile,
      positioning: { level: "Senior", strategy: "", notes: "" },
      experiences: [{ ...profile.experiences[0]!, role: "Engineering Director" }]
    };
    expect(sanitizeEvidencePlan(plan, seniorProfile, job).plan.summaryBlueprint?.archetype).toBe("senior");
  });

  it("keeps the LLM summary and re-derives claims when the LLM's own claims don't match the plan", async () => {
    // Mimics the career-change failure: the LLM writes good prose but returns a claim id
    // the plan doesn't contain, so every LLM claim is dropped. The prose must survive
    // (claims re-derived from the plan), NOT be replaced by the deterministic template.
    const changeSummary = "Backend Engineer bringing proven TypeScript API delivery to reliable production services. Built and shipped APIs used by 12 internal teams while automating continuous integration pipelines. Focused on dependable backend systems that scale with team needs.";
    const unmatchedClaimWriter = {
      ...writer,
      summary: changeSummary,
      summaryClaims: [{
        id: "llm-invented-id",
        text: "proven TypeScript API delivery",
        evidence: [{ sourceExperienceId: "source-1", sourceBulletIndexes: [0] }]
      }]
    };
    const generate = dispatchGenerator({ writer: unmatchedClaimWriter });
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-change" });

    expect(cv.summary).toBe(changeSummary);
    expect(cv.summary).not.toMatch(/transitioning into|Relevant strengths for/i);
    expect(cv.summaryClaims.length).toBeGreaterThan(0);
    expect(cv.pipeline.recoveries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source-summary-restored" })
    ]));
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
    const generate = dispatchGenerator({ plan: invalid, writer: safeWriter });
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-2" });
    expect(generate).toHaveBeenCalledTimes(5);
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
    const generate = dispatchGenerator({ writer: unsafeWriter, repair: writer });
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-3" });
    expect(generate).toHaveBeenCalledTimes(6);
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
    const generate = dispatchGenerator({ plan: weakPlan, writer: unsafeWriter });
    const cv = await generateUnifiedCv({
      generator: { generate },
      profile: certifiedProfile,
      job,
      runId: "run-certifications"
    });

    expect(cv.experiences[0]?.role).toBe("Software Developer");
    // Certifications are now deterministic — copied from the profile and never
    // written by the LLM — so a renamed cert in the plan cannot reach the CV.
    expect(cv.certifications).toEqual(certifiedProfile.certifications);
    expect(cv.pipeline.recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "title-reframe-reverted" })
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

    const sanitizedSkillNames = result.plan.skills.map((skill) => skill.skill);
    // The unsupported "Kubernetes" entry is dropped, source skills are retained,
    // and the looser pipeline tops up with inferred baselines (incl. Excel).
    expect(sanitizedSkillNames).toEqual(expect.arrayContaining(["TypeScript", "API Design", "Microsoft Excel"]));
    expect(sanitizedSkillNames).not.toContain("Kubernetes");
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
    const generate = dispatchGenerator({ writer: invalidWriter });
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job, runId: "run-sanitize-writer" });

    expect(cv.experiences[0]?.role).toBe("Backend Developer");
    expect(cv.experiences[0]?.bullets[0]?.text).toBe(profile.experiences[0]?.bullets[0]);
    expect(cv.skills).toEqual(expect.arrayContaining(["TypeScript", "API Design"]));
    expect(cv.summary).toContain("12 internal teams");
    expect(cv.readiness).toBe("ready");
  });

  it("returns a ready CV with findings as warnings when the base profile has no experience evidence", async () => {
    const emptyProfile = { ...profile, experiences: [], summary: "", rawText: "" };
    const emptyPlan = { ...plan, summaryClaims: [], roles: [], skills: [], certifications: [] };
    const emptyWriter = { ...writer, summary: "", summaryClaims: [], roles: [], skillCategories: [], skillEvidence: [], certifications: [] };
    const generate = dispatchGenerator({ plan: emptyPlan, writer: emptyWriter, repair: emptyWriter });
    const cv = await generateUnifiedCv({ generator: { generate }, profile: emptyProfile, job, runId: "run-empty" });

    expect(cv.experiences).toEqual([]);
    // Output is never blocked anymore; the finding surfaces as a non-blocking warning.
    expect(cv.readiness).toBe("ready");
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
    const generate = dispatchGenerator({ plan: sparsePlan, writer: sparseWriter });
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
    expect(cv.sectionOrder.slice(0, 4)).toEqual(["summary", "experience", "projects", "skills"]);
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

  it("strips a leaked inferred-baseline sentence but keeps the rest of the LLM summary", async () => {
    // The JD deliberately does NOT name "communication": an inferred-baseline skill
    // the job does not mention must not leak into the summary or bullets (it may only
    // appear in the skills section). Only the offending sentence is removed — the rest
    // of the LLM prose survives verbatim rather than being replaced by the template.
    const communicationJob = { ...job };
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
      summary: "Backend developer with hands-on TypeScript API delivery experience across production services. Skilled in strong Communication with cross-functional teams. Ships reliable APIs used by 12 internal teams every day.",
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
    const generate = dispatchGenerator({ plan: inferredPlan, writer: leakingWriter });
    const cv = await generateUnifiedCv({ generator: { generate }, profile, job: communicationJob, runId: "inferred-scope" });

    expect(cv.skills).toContain("Communication");
    expect(cv.summary).not.toContain("Communication");
    // The non-leaking sentences survive verbatim — the summary is NOT replaced by the template.
    expect(cv.summary).toContain("TypeScript API delivery experience");
    expect(cv.summary).not.toMatch(/transitioning into|Relevant strengths for/i);
    expect(cv.pipeline.recoveries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source-summary-restored" })
    ]));
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

  it("does not hard-flag summary-claim mismatches — the summary is trusted LLM prose", () => {
    // Summary bookkeeping (reused base summary, unplanned/mismatched claims, positioning)
    // must NOT surface as validateWriterOutput findings, since every finding is a hard
    // failure that would nuke the LLM summary into the deterministic template. Its factual
    // integrity is enforced by stripping in sanitizeWriterOutput instead.
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
      summaryClaims: [{ id: "llm-invented-id", text: profile.summary, evidence: [] }]
    }, result.plan, profile, { ...job, title: "KYC Analyst" });
    expect(findings).not.toContain("Writer reused the generic base summary despite job-specific summary evidence");
    expect(findings.some((finding) => /summary claim/i.test(finding))).toBe(false);
  });

  it("splits a compound base-skill blob and fills out a thin accounting profile", () => {
    const blobProfile: BaseProfile = {
      ...profile,
      targetRole: "AP Accountant",
      summary: "Accounting associate handling payables and account reconciliations.",
      experiences: [{
        id: "source-1",
        company: "Acme",
        role: "Accounting Associate",
        startDate: "2023",
        endDate: "Present",
        bullets: ["Reconciled account statements in SAP and processed supplier invoices."]
      }],
      skills: ["SAP (AR/AP, Account Statements, Oracle Financials (Training), Report Extraction)"],
      skillCategories: { Skills: ["SAP (AR/AP, Account Statements, Oracle Financials (Training), Report Extraction)"] }
    };
    const apJob: JobDescription = {
      ...job,
      title: "AP Accountant",
      description: "Process supplier invoices, reconcile accounts payable, and support month-end close."
    };
    const names = sanitizeEvidencePlan(plan, blobProfile, apJob).plan.skills.map((skill) => skill.skill);

    // Compound blob is split into distinct source skills.
    expect(names).toEqual(expect.arrayContaining([
      "SAP", "AR/AP", "Account Statements", "Oracle Financials", "Report Extraction"
    ]));
    // Excel is added even though the JD never says "excel".
    expect(names).toContain("Microsoft Excel");
    // Accounting-domain inferences are seeded from the target role.
    expect(names).toEqual(expect.arrayContaining(["Reconciliations", "Month-End Close"]));
    // Not the single-skill collapse the bug produced.
    expect(names.length).toBeGreaterThanOrEqual(12);
  });

  it("bridges an accounting profile into a data-analysis target", () => {
    const analystJob: JobDescription = {
      ...job,
      title: "Data Analyst",
      description: "Analyze datasets, build dashboards and reporting, and surface business insights."
    };
    const accountingSource: BaseProfile = {
      ...profile,
      targetRole: "Data Analyst",
      summary: "Accountant who reconciles ledgers and prepares financial reporting.",
      experiences: [{
        id: "source-1",
        company: "Acme",
        role: "Accountant",
        startDate: "2022",
        endDate: "Present",
        bullets: ["Reconciled the general ledger and prepared monthly financial reporting."]
      }],
      skills: ["Account Reconciliation", "Financial Reporting", "Advanced Excel"],
      skillCategories: { Skills: ["Account Reconciliation", "Financial Reporting", "Advanced Excel"] }
    };
    const names = sanitizeEvidencePlan(plan, accountingSource, analystJob).plan.skills.map((skill) => skill.skill);

    // Target-domain / bridge skills appear for the move into data analysis.
    expect(names).toEqual(expect.arrayContaining(["SQL", "Data Visualization", "Data Analysis"]));
    // Transferable source skills are retained.
    expect(names).toContain("Advanced Excel");
  });

  it("bridges an admin/psychology profile into a KYC/AML target", () => {
    const kycJob: JobDescription = {
      ...job,
      title: "KYC/AML Analyst",
      description: "Perform customer due diligence, transaction monitoring and sanctions screening for compliance."
    };
    const adminSource: BaseProfile = {
      ...profile,
      targetRole: "KYC/AML Analyst",
      summary: "Administrative coordinator with psychology background and strong documentation skills.",
      experiences: [{
        id: "source-1",
        company: "Acme",
        role: "Administrative Coordinator",
        startDate: "2022",
        endDate: "Present",
        bullets: ["Managed records, scheduling and stakeholder coordination across teams."]
      }],
      skills: ["Records Management", "Stakeholder Coordination", "Report Writing"],
      skillCategories: { Skills: ["Records Management", "Stakeholder Coordination", "Report Writing"] }
    };
    const names = sanitizeEvidencePlan(plan, adminSource, kycJob).plan.skills.map((skill) => skill.skill);

    expect(names).toEqual(expect.arrayContaining([
      "KYC", "AML", "Customer Due Diligence", "Risk Assessment"
    ]));
  });
});

describe("evidencePlanSchema evidence-array coercion", () => {
  it("accepts a single object where titleEvidence/evidence should be an array", () => {
    const ref = { sourceExperienceId: "source-1", sourceBulletIndexes: [0] };
    const looseplan = {
      ...plan,
      requirements: [{ ...plan.requirements[0], evidence: ref }],
      summaryClaims: [{ ...plan.summaryClaims[0], evidence: ref }],
      roles: [{ ...plan.roles[0], titleEvidence: ref }],
      skills: [{ ...plan.skills[0], evidence: ref }]
    };

    const parsed = evidencePlanSchema.parse(looseplan);

    expect(parsed.roles[0]?.titleEvidence).toEqual([ref]);
    expect(parsed.requirements[0]?.evidence).toEqual([ref]);
    expect(parsed.summaryClaims[0]?.evidence).toEqual([ref]);
    expect(parsed.skills[0]?.evidence).toEqual([ref]);
  });
});
