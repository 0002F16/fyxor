import {
  evidencePlanSchema,
  regenerationPatchSchema,
  tailoredCvSchema,
  type BaseProfile,
  type EvidencePlan,
  type EvaluationFinding,
  type JobDescription,
  type RegenerationPatch,
  type ResumeEvaluation,
  type SummaryEvidenceReference,
  type SkillProvenance,
  type TailoredCv
} from "@cv-tailor/shared";
import type { Generator } from "./openai.js";
import {
  evidencePlannerPrompt,
  evidenceWriterPrompt,
  experienceWriterPrompt,
  resumeCriticPrompt,
  resumeRepairPrompt,
  skillsWriterPrompt,
  summaryWriterPrompt
} from "./prompts.js";
import {
  llmCriticSchema,
  llmEvidencePlanSchema,
  llmExperienceWriterSchema,
  llmResumeWriterSchema,
  llmSkillsWriterSchema,
  llmSummaryWriterSchema
} from "./schemas.js";
import { evaluateTailoredCv } from "./resumeEval.js";

export const PIPELINE_VERSION = "unified-v4";

type WriterOutput = typeof llmResumeWriterSchema._type;
type StageProgress = (stage: string, progress: number) => Promise<void> | void;
type StageMetric = { name: string; durationMs: number; attempts: number; inputTokens?: number; outputTokens?: number };
type Recovery = {
  code: string;
  section: string;
  sourceExperienceId: string;
  severity: "corrected" | "dropped" | "degraded";
};

export class EvidencePlanError extends Error {
  constructor(public findings: string[]) {
    super(`Evidence plan is invalid: ${findings.join("; ")}`);
  }
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

// Substring match, but require a word boundary for very short terms so that
// ambiguous acronyms ("ap", "ar", "gl") don't match inside unrelated words
// (e.g. "ap" inside "SAP" / "Variance Analysis").
function matchesTerm(text: string, term: string): boolean {
  const haystack = normalized(text);
  const needle = normalized(term);
  if (!needle) return false;
  if (needle.length > 3) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, "u").test(haystack);
}

function numberTokens(value: string): string[] {
  return (value.match(/(?<![\p{L}\p{N}])(?:[$€£]\s*)?\d+(?:[.,]\d+)*(?:\s*[%x×+])?(?![\p{L}\p{N}])/gu) || [])
    .map((token) => token.replace(/\s+/g, "").toLocaleLowerCase());
}

function unsupportedSummaryNumbers(summary: string, profile: BaseProfile): string[] {
  const source = [
    profile.summary,
    profile.rawText,
    ...profile.experiences.flatMap((role) => [role.startDate, role.endDate, ...role.bullets]),
    ...profile.education.flatMap((entry) => [entry.graduationDate, entry.gpa, ...entry.coursework]),
    ...(profile.projects || []).flatMap((project) => [project.description, ...project.bullets])
  ].join(" ");
  const allowed = new Set(numberTokens(source));
  return Array.from(new Set(numberTokens(summary).filter((token) => !allowed.has(token))));
}

const SKILL_FRAGMENT_STOPWORDS = new Set([
  "training", "basic", "intermediate", "advanced", "beginner", "proficient",
  "expert", "familiar", "knowledge", "experience", "skills", "etc"
]);

// Break one stored skill entry (which may be a compound blob like
// "SAP (AR/AP, Account Statements, Oracle Financials (Training), Report Extraction)")
// into distinct skills: the head term plus each comma-separated inner term.
function splitSkillEntry(raw: string): string[] {
  if (!raw) return [];
  const fragments: string[] = [];
  // Pull out parenthetical groups, recording both the head term and the inner list.
  let head = raw.replace(/\(([^()]*)\)/g, (_match, inner: string) => {
    for (const piece of String(inner).split(/[,;]/)) fragments.push(piece);
    return " ";
  });
  // Some entries nest one more level; flatten a second pass on the head.
  head = head.replace(/\(([^()]*)\)/g, (_match, inner: string) => {
    for (const piece of String(inner).split(/[,;]/)) fragments.push(piece);
    return " ";
  });
  for (const piece of head.split(/[,;]/)) fragments.push(piece);

  const seen = new Map<string, string>();
  for (const fragment of fragments) {
    const cleaned = fragment.replace(/\s+/g, " ").trim();
    if (cleaned.length < 2) continue;
    const key = normalized(cleaned);
    if (SKILL_FRAGMENT_STOPWORDS.has(key)) continue;
    if (!seen.has(key)) seen.set(key, cleaned);
  }
  return [...seen.values()];
}

function profileSkillSet(profile: BaseProfile): Set<string> {
  return new Set(profileSkills(profile).map(normalized));
}

function summaryEvidenceKey(reference: SummaryEvidenceReference): string {
  return JSON.stringify({
    kind: reference.kind || "experience",
    sourceExperienceId: reference.sourceExperienceId || "",
    sourceBulletIndexes: reference.sourceBulletIndexes || [],
    language: normalized(reference.language || ""),
    level: normalized(reference.level || ""),
    skill: normalized(reference.skill || ""),
    certification: normalized(reference.certification || ""),
    educationId: reference.educationId || "",
    projectId: reference.projectId || "",
    value: normalized(reference.value || ""),
    basis: normalized(reference.basis || ""),
    confidence: reference.confidence || "high"
  });
}

function summaryEvidenceAllowed(
  reference: SummaryEvidenceReference,
  allowed: SummaryEvidenceReference
): boolean {
  const kind = reference.kind || "experience";
  if (kind !== (allowed.kind || "experience")) return false;
  if (kind === "experience") {
    const indexes = reference.sourceBulletIndexes || [];
    const allowedIndexes = new Set(allowed.sourceBulletIndexes || []);
    return reference.sourceExperienceId === allowed.sourceExperienceId &&
      indexes.length > 0 && indexes.every((index) => allowedIndexes.has(index));
  }
  if (kind === "language") {
    return normalized(reference.language || "") === normalized(allowed.language || "") &&
      (!reference.level || normalized(reference.level) === normalized(allowed.level || ""));
  }
  if (kind === "skill") return normalized(reference.skill || "") === normalized(allowed.skill || "");
  if (kind === "certification") {
    return normalized(reference.certification || "") === normalized(allowed.certification || "");
  }
  if (kind === "education") return reference.educationId === allowed.educationId;
  if (kind === "employment") return reference.sourceExperienceId === allowed.sourceExperienceId;
  if (kind === "project") return reference.projectId === allowed.projectId;
  if (kind === "authorization") return true;
  return summaryEvidenceKey(reference) === summaryEvidenceKey(allowed);
}

function authorizationText(profile: BaseProfile): string {
  const source = `${profile.summary}\n${profile.rawText}`;
  return source
    .split(/\n|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .find((part) =>
      /\b(work authori[sz]ation|authori[sz]ed to work|right to work|without sponsorship|no sponsorship|visa|residence permit)\b/i.test(part)
    ) || "";
}

function summaryEvidenceText(reference: SummaryEvidenceReference, profile: BaseProfile): string {
  const kind = reference.kind || "experience";
  if (kind === "experience") {
    const source = profile.experiences.find((role) => role.id === (reference.sourceExperienceId || ""));
    return source
      ? (reference.sourceBulletIndexes || []).map((index) => source.bullets[index] || "").filter(Boolean).join(" ")
      : "";
  }
  if (kind === "language") {
    const source = profile.languages.find((entry) => normalized(entry.language) === normalized(reference.language || ""));
    return source ? [source.language, source.level].filter(Boolean).join(" ") : "";
  }
  if (kind === "skill") {
    return profileSkills(profile).find((skill) => normalized(skill) === normalized(reference.skill || "")) || "";
  }
  if (kind === "certification") {
    return profile.certifications.find((entry) => normalized(entry) === normalized(reference.certification || "")) || "";
  }
  if (kind === "education") {
    const source = profile.education.find((entry) => entry.id === (reference.educationId || ""));
    return source ? [source.degree, source.school, source.honors, source.gpa].filter(Boolean).join(" ") : "";
  }
  if (kind === "employment") {
    const source = profile.experiences.find((role) => role.id === (reference.sourceExperienceId || ""));
    if (!source) return "";
    return reference.value || `${source.role} at ${source.company}`;
  }
  if (kind === "project") {
    const source = (profile.projects || []).find((project) => project.id === (reference.projectId || ""));
    return source
      ? reference.value || [source.title, source.description, ...source.bullets, ...source.technologies].filter(Boolean).join(" ")
      : "";
  }
  if (kind === "authorization") return authorizationText(profile);
  if (kind === "inference") return (reference.confidence || "high") === "high" && (reference.basis || "").trim()
    ? reference.value || ""
    : "";
  return "";
}

function sanitizeSummaryEvidence(
  references: SummaryEvidenceReference[],
  profile: BaseProfile
): SummaryEvidenceReference[] {
  return references.filter((reference) => {
    if ((reference.kind || "experience") === "inference") {
      return (reference.confidence || "high") === "high" &&
        Boolean((reference.value || "").trim() && (reference.basis || "").trim()) &&
        /\b(context|sector|industry)\b/i.test(reference.value || "") &&
        /\b(employer|company|role)\b/i.test(reference.basis || "");
    }
    return Boolean(summaryEvidenceText(reference, profile));
  });
}

function summaryEvidenceCatalogue(profile: BaseProfile): Array<{ text: string; evidence: SummaryEvidenceReference }> {
  const catalogue: Array<{ text: string; evidence: SummaryEvidenceReference }> = [];
  const push = (text: string, evidence: SummaryEvidenceReference) => {
    if (text.trim()) catalogue.push({ text: text.trim(), evidence });
  };
  for (const role of profile.experiences) {
    push(`${role.role} at ${role.company}`, {
      kind: "employment", sourceExperienceId: role.id, value: `${role.role} at ${role.company}`,
      sourceBulletIndexes: [], language: "", level: "", skill: "", certification: "",
      educationId: "", projectId: "", basis: "", confidence: "high"
    });
    role.bullets.forEach((bullet, index) => push(bullet, {
      kind: "experience", sourceExperienceId: role.id, sourceBulletIndexes: [index],
      language: "", level: "", skill: "", certification: "", educationId: "", projectId: "",
      value: "", basis: "", confidence: "high"
    }));
  }
  for (const language of profile.languages) push(`${language.language} ${language.level}`, {
    kind: "language", language: language.language, level: language.level, sourceExperienceId: "",
    sourceBulletIndexes: [], skill: "", certification: "", educationId: "", projectId: "",
    value: "", basis: "", confidence: "high"
  });
  for (const skill of profileSkills(profile)) push(skill, {
    kind: "skill", skill, sourceExperienceId: "", sourceBulletIndexes: [], language: "", level: "",
    certification: "", educationId: "", projectId: "", value: "", basis: "", confidence: "high"
  });
  for (const certification of profile.certifications) push(certification, {
    kind: "certification", certification, sourceExperienceId: "", sourceBulletIndexes: [],
    language: "", level: "", skill: "", educationId: "", projectId: "", value: "", basis: "",
    confidence: "high"
  });
  for (const education of profile.education) push(
    [education.degree, education.school, education.honors].filter(Boolean).join(" "),
    {
      kind: "education", educationId: education.id, sourceExperienceId: "", sourceBulletIndexes: [],
      language: "", level: "", skill: "", certification: "", projectId: "", value: "", basis: "",
      confidence: "high"
    }
  );
  for (const project of profile.projects || []) push(
    [project.title, project.description, ...project.bullets, ...project.technologies].filter(Boolean).join(" "),
    {
      kind: "project", projectId: project.id, sourceExperienceId: "", sourceBulletIndexes: [],
      language: "", level: "", skill: "", certification: "", educationId: "", value: "", basis: "",
      confidence: "high"
    }
  );
  const authorization = authorizationText(profile);
  if (authorization) push(authorization, {
    kind: "authorization", value: authorization, sourceExperienceId: "", sourceBulletIndexes: [],
    language: "", level: "", skill: "", certification: "", educationId: "", projectId: "", basis: "",
    confidence: "high"
  });
  return catalogue;
}

function requirementType(text: string): NonNullable<EvidencePlan["requirements"][number]["type"]> {
  const value = normalized(text);
  if (/\b(language|fluent|native|[abc][12])\b/.test(value)) return "language";
  if (/\b(certification|certified|acca|cpa|cfa|acams|pmp|cissp)\b/.test(value)) return "certification";
  if (/\b(license|licence|licensed)\b/.test(value)) return "license";
  if (/\b(work authori|right to work|sponsorship|visa)\b/.test(value)) return "authorization";
  if (/\b(degree|bachelor|master|university|education)\b/.test(value)) return "education";
  if (/\b(senior|lead|manager|director|head|vp|vice president|chief)\b/.test(value)) return "seniority";
  if (BASELINE_SKILLS.some((entry) => entry.terms.some((term) => value.includes(term)))) return "competency";
  if (profileToolTerms.some((term) => value.includes(term))) return "tool";
  return "other";
}

function inferredIndustryEvidence(
  requirement: EvidencePlan["requirements"][number],
  profile: BaseProfile
): SummaryEvidenceReference[] {
  if ((requirement.type || requirementType(requirement.text)) !== "industry") return [];
  const sectors = [
    { requirement: /health|medical|pharma|life science|biotech/i, employer: /medic|health|pharma|clinic|hospital|device|biotech/i, label: "healthcare" },
    { requirement: /bank|financial service|fintech/i, employer: /bank|capital|fund|financ|credit|payments?/i, label: "financial-services" },
    { requirement: /retail|e-?commerce|consumer/i, employer: /retail|shop|store|commerce|consumer|brand/i, label: "consumer" },
    { requirement: /software|saas|technology/i, employer: /software|systems?|digital|tech|cloud/i, label: "technology" },
    { requirement: /manufactur|industrial/i, employer: /manufactur|industrial|factory|plant/i, label: "industrial" },
    { requirement: /energy|utilities/i, employer: /energy|power|utility|solar|oil|gas/i, label: "energy" }
  ];
  const sector = sectors.find((entry) => entry.requirement.test(requirement.text));
  if (!sector) return [];
  const role = profile.experiences.find((entry) =>
    sector.employer.test(`${entry.company} ${entry.role}`)
  );
  if (!role) return [];
  return [{
    kind: "inference",
    sourceExperienceId: role.id,
    sourceBulletIndexes: [],
    value: `${sector.label.replace("-", " ")} context at ${role.company}`,
    basis: `${role.role} at employer ${role.company}`,
    confidence: "high"
  }];
}

const profileToolTerms = [
  "excel", "sap", "oracle", "salesforce", "servicenow", "python", "typescript", "javascript",
  "sql", "power bi", "tableau", "netSuite", "concur", "databricks", "jira"
].map(normalized);

function decisiveRequirement(requirement: EvidencePlan["requirements"][number]): boolean {
  return requirement.priority === "must" &&
    ["language", "certification", "license", "authorization"].includes(requirement.type || "other") &&
    ["explicit", "supported-equivalent"].includes(requirement.coverage) &&
    (requirement.summaryEvidence || []).length > 0;
}

const BASELINE_SKILLS = [
  { skill: "Microsoft Excel", terms: ["microsoft excel", "excel"] },
  { skill: "Microsoft Office", terms: ["microsoft office", "ms office", "office suite"] },
  { skill: "Data Analysis", terms: ["data analysis", "analytical"] },
  { skill: "Communication", terms: ["communication", "communicate", "interpersonal"] },
  { skill: "Attention to Detail", terms: ["attention to detail", "accuracy", "detail oriented"] },
  { skill: "Problem-Solving", terms: ["problem solving", "problem-solving"] },
  { skill: "Teamwork", terms: ["teamwork", "collaborative", "collaboration"] },
  { skill: "Time Management", terms: ["time management", "deadlines"] },
  { skill: "Organization", terms: ["organization", "organisational", "organizational"] }
] as const;
type SkillDomain =
  | "accounting" | "data-analysis" | "compliance" | "admin" | "software"
  | "operations" | "sales-marketing" | "hr" | "customer-support" | "psychology";

// Domain-specific skills the pipeline may infer (as inferred-baseline) for the
// target role — even when the JD does not literally name them. Drives both
// same-domain enrichment and transferable/adjacent transitions.
const DOMAIN_SKILLS: Record<SkillDomain, { skill: string; terms: string[] }[]> = {
  accounting: [
    { skill: "Accounts Payable", terms: ["accounts payable", "ap", "payables"] },
    { skill: "Accounts Receivable", terms: ["accounts receivable", "ar", "receivables"] },
    { skill: "Reconciliations", terms: ["reconcil", "reconciliation"] },
    { skill: "Journal Entries", terms: ["journal entr", "journal"] },
    { skill: "Month-End Close", terms: ["month end", "month-end", "closing", "period close"] },
    { skill: "General Ledger", terms: ["general ledger", "gl"] },
    { skill: "Financial Reporting", terms: ["financial reporting", "financial statement"] },
    { skill: "Accruals", terms: ["accrual"] },
    { skill: "ERP Systems", terms: ["erp", "sap", "oracle", "netsuite", "quickbooks"] }
  ],
  "data-analysis": [
    { skill: "SQL", terms: ["sql", "queries", "database"] },
    { skill: "Data Visualization", terms: ["data visualization", "dashboard", "visualisation"] },
    { skill: "Excel Modeling", terms: ["excel model", "spreadsheet model", "financial model"] },
    { skill: "Statistical Analysis", terms: ["statistic", "regression", "forecasting"] },
    { skill: "Reporting Dashboards", terms: ["reporting", "kpi", "metrics"] },
    { skill: "Power BI", terms: ["power bi", "powerbi"] },
    { skill: "Tableau", terms: ["tableau"] },
    { skill: "Data Cleaning", terms: ["data cleaning", "data cleansing", "data wrangling"] }
  ],
  compliance: [
    { skill: "KYC", terms: ["kyc", "know your customer"] },
    { skill: "AML", terms: ["aml", "anti-money laundering", "anti money laundering"] },
    { skill: "Customer Due Diligence", terms: ["due diligence", "cdd", "edd"] },
    { skill: "Risk Assessment", terms: ["risk assessment", "risk analysis", "risk"] },
    { skill: "Regulatory Compliance", terms: ["regulatory", "compliance", "regulation"] },
    { skill: "Transaction Monitoring", terms: ["transaction monitoring", "monitoring"] },
    { skill: "Sanctions Screening", terms: ["sanctions", "screening", "pep"] },
    { skill: "Case Documentation", terms: ["case documentation", "case management", "sar"] }
  ],
  admin: [
    { skill: "Calendar Management", terms: ["calendar", "scheduling", "diary"] },
    { skill: "Document Management", terms: ["document management", "filing", "documentation"] },
    { skill: "Data Entry", terms: ["data entry"] },
    { skill: "Stakeholder Coordination", terms: ["stakeholder", "coordination", "liaison"] },
    { skill: "Records Management", terms: ["records management", "record keeping", "recordkeeping"] }
  ],
  software: [
    { skill: "Python", terms: ["python"] },
    { skill: "JavaScript", terms: ["javascript", "typescript", "node"] },
    { skill: "Git", terms: ["git", "version control"] },
    { skill: "API Development", terms: ["api", "rest", "graphql"] },
    { skill: "Debugging", terms: ["debug", "troubleshoot"] },
    { skill: "Automated Testing", terms: ["testing", "unit test", "qa"] }
  ],
  operations: [
    { skill: "Process Improvement", terms: ["process improvement", "process", "lean", "six sigma"] },
    { skill: "Project Coordination", terms: ["project", "coordination", "planning"] },
    { skill: "Vendor Management", terms: ["vendor", "supplier", "procurement"] },
    { skill: "Inventory Management", terms: ["inventory", "stock", "supply chain"] },
    { skill: "Workflow Optimization", terms: ["workflow", "optimization", "efficiency"] }
  ],
  "sales-marketing": [
    { skill: "CRM", terms: ["crm", "salesforce", "hubspot"] },
    { skill: "Lead Generation", terms: ["lead generation", "prospecting", "leads"] },
    { skill: "Market Research", terms: ["market research", "market analysis"] },
    { skill: "Content Creation", terms: ["content", "copywriting", "social media"] },
    { skill: "Campaign Management", terms: ["campaign", "marketing campaign"] }
  ],
  hr: [
    { skill: "Recruitment", terms: ["recruit", "talent acquisition", "hiring", "sourcing"] },
    { skill: "Onboarding", terms: ["onboarding"] },
    { skill: "Employee Relations", terms: ["employee relations", "er"] },
    { skill: "HRIS", terms: ["hris", "workday", "people system"] },
    { skill: "Performance Management", terms: ["performance management", "appraisal"] }
  ],
  "customer-support": [
    { skill: "Customer Service", terms: ["customer service", "customer support", "client service"] },
    { skill: "Ticketing Systems", terms: ["ticketing", "zendesk", "helpdesk", "service desk"] },
    { skill: "Conflict Resolution", terms: ["conflict resolution", "de-escalation", "complaints"] },
    { skill: "Client Onboarding", terms: ["client onboarding", "account setup"] }
  ],
  psychology: [
    { skill: "Behavioral Analysis", terms: ["behavioral", "behaviour", "behavioral analysis"] },
    { skill: "Interviewing", terms: ["interview", "assessment"] },
    { skill: "Active Listening", terms: ["active listening", "listening", "empathy"] },
    { skill: "Report Writing", terms: ["report writing", "case notes"] },
    { skill: "Case Management", terms: ["case management", "caseload"] }
  ]
};

// Keywords that signal a domain in the job (target) or profile (source) text.
const DOMAIN_KEYWORDS: Record<SkillDomain, string[]> = {
  accounting: ["account", "accounts payable", "accounts receivable", "ledger", "reconcil",
    "bookkeep", "audit", "tax", "invoice", "financial statement", "month end", "ap ", "ar ", "finance"],
  "data-analysis": ["data analy", "data analyst", "analytics", "sql", "power bi", "tableau",
    "dashboard", "reporting", "statistic", "insight", "business intelligence", "bi "],
  compliance: ["kyc", "aml", "anti-money", "due diligence", "compliance", "regulatory",
    "sanctions", "fraud", "risk", "onboarding analyst", "transaction monitoring"],
  admin: ["administrat", "admin assistant", "office", "clerical", "data entry", "secretar",
    "receptionist", "coordinator", "scheduling"],
  software: ["software", "developer", "engineer", "programming", "frontend", "backend",
    "full stack", "api", "web develop"],
  operations: ["operations", "logistics", "supply chain", "procurement", "process improvement",
    "project coordinat", "operations analyst"],
  "sales-marketing": ["sales", "marketing", "business development", "account executive",
    "campaign", "seo", "growth", "brand"],
  hr: ["human resources", "hr ", "recruit", "talent", "people operations", "onboarding specialist"],
  "customer-support": ["customer service", "customer support", "client support", "help desk",
    "service desk", "call center", "contact center"],
  psychology: ["psycholog", "counsel", "behavioral", "mental health", "social work", "therap"]
};

// Adjacent domains whose skills transfer — used to seed transition bridges.
const DOMAIN_ADJACENCY: Record<SkillDomain, SkillDomain[]> = {
  accounting: ["data-analysis", "compliance", "operations", "admin"],
  "data-analysis": ["accounting", "operations", "software", "compliance"],
  compliance: ["accounting", "data-analysis", "admin", "operations"],
  admin: ["compliance", "operations", "customer-support", "hr"],
  software: ["data-analysis", "operations"],
  operations: ["accounting", "data-analysis", "admin", "sales-marketing"],
  "sales-marketing": ["operations", "customer-support", "data-analysis"],
  hr: ["admin", "psychology", "customer-support"],
  "customer-support": ["admin", "sales-marketing", "compliance"],
  psychology: ["hr", "compliance", "customer-support", "admin"]
};

// Every skill the pipeline is allowed to infer (universal baselines + all domains).
const INFERRED_SKILL_ALLOWED = new Set<string>([
  ...BASELINE_SKILLS.map((entry) => normalized(entry.skill)),
  ...Object.values(DOMAIN_SKILLS).flat().map((entry) => normalized(entry.skill))
]);

function detectDomainsFromText(text: string): SkillDomain[] {
  const haystack = normalized(text);
  return (Object.keys(DOMAIN_KEYWORDS) as SkillDomain[]).filter((domain) =>
    DOMAIN_KEYWORDS[domain].some((keyword) => haystack.includes(keyword))
  );
}

function detectTargetDomains(job?: JobDescription): SkillDomain[] {
  if (!job) return [];
  return detectDomainsFromText(`${job.title} ${job.title} ${job.description}`);
}

function detectSourceDomains(profile: BaseProfile): SkillDomain[] {
  const text = [
    profile.summary,
    profile.positioning?.level || "",
    ...profile.experiences.map((role) => role.role),
    ...profileSkills(profile)
  ].join(" ");
  return detectDomainsFromText(text);
}

const EXCEL_ECOSYSTEM = ["excel", "power query", "pivot table", "vlookup", "macro"];
const IMPORTANT_EVIDENCE_TERMS = [
  "report", "month end", "close", "reconcil", "control", "audit", "excel", "system",
  "process", "journal", "ledger", "balance sheet", "financial statement", "stakeholder"
];
const TOKEN_STOPWORDS = new Set([
  "and", "the", "with", "for", "from", "into", "using", "use", "skills", "skill",
  "ability", "strong", "advanced", "experience", "knowledge", "support", "manage"
]);

function tokens(value: string): string[] {
  return normalized(value)
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .split(" ")
    .map((token) => token.replace(/(?:ing|ed|es|s)$/u, ""))
    .filter((token) => token.length > 2 && !TOKEN_STOPWORDS.has(token));
}

function textMatchScore(needle: string, haystack: string): number {
  const left = normalized(needle);
  const right = normalized(haystack);
  if (!left || !right) return 0;
  if (right.includes(left)) return 10;
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap ? overlap / Math.max(1, leftTokens.size) * 6 : 0;
}

function profileSkills(profile: BaseProfile): string[] {
  return Array.from(new Map([
    ...profile.skills,
    ...Object.values(profile.skillCategories).flat()
  ].filter(Boolean).flatMap(splitSkillEntry).map((skill) => [normalized(skill), skill])).values());
}

function categoryForSkill(profile: BaseProfile, skill: string): string {
  return Object.entries(profile.skillCategories)
    .find(([, entries]) => entries.some((entry) => normalized(entry) === normalized(skill)))?.[0] || "Skills";
}

function evidenceForText(profile: BaseProfile, text: string) {
  return profile.experiences.flatMap((role) => {
    const indexes = role.bullets.flatMap((bullet, index) => textMatchScore(text, bullet) >= 3 ? [index] : []);
    return indexes.length ? [{ sourceExperienceId: role.id, sourceBulletIndexes: indexes }] : [];
  });
}

function seniorProfile(profile: BaseProfile): boolean {
  const seniorPattern = /\b(senior|sr\.?|lead|manager|head|director|principal|chief|vp|vice president)\b/i;
  return seniorPattern.test(profile.positioning?.level || "") ||
    profile.experiences.some((role) => seniorPattern.test(role.role));
}

function pageTargetFor(profile: BaseProfile): "one" | "two" {
  const evidenceVolume = profile.experiences.reduce((sum, role) => sum + role.bullets.length, 0);
  return seniorProfile(profile) && (profile.experiences.length > 1 || evidenceVolume > 8) ? "two" : "one";
}

function sectionOrderFor(profile: BaseProfile): string[] {
  return profile.experiences.length
    ? ["summary", "experience", "skills", "certifications", "languages", "education"]
    : ["summary", "skills", "certifications", "languages", "education", "experience"];
}

function deterministicRequirements(profile: BaseProfile, job?: JobDescription): EvidencePlan["requirements"] {
  if (!job) return [];
  const jobText = normalized(`${job.title} ${job.description}`);
  const requirements: EvidencePlan["requirements"] = [];
  const add = (requirement: EvidencePlan["requirements"][number]) => {
    if (!requirements.some((entry) => normalized(entry.text) === normalized(requirement.text))) requirements.push(requirement);
  };

  for (const language of profile.languages) {
    if (!language.language.trim() || !jobText.includes(normalized(language.language))) continue;
    add({
      id: `decisive-language-${normalized(language.language).replace(/\s+/g, "-")}`,
      text: [language.language, language.level].filter(Boolean).join(" "),
      priority: "must",
      type: "language",
      hiringImportance: 5,
      summaryValue: 5,
      coverage: "explicit",
      evidence: [],
      summaryEvidence: [{
        kind: "language",
        language: language.language,
        level: language.level,
        sourceExperienceId: "",
        sourceBulletIndexes: [],
        skill: "",
        certification: "",
        educationId: "",
        projectId: "",
        value: "",
        basis: "",
        confidence: "high"
      }],
      sourceSkills: []
    });
  }

  for (const certification of profile.certifications) {
    const acronyms = certification.match(/\b[A-Z][A-Z0-9]{1,7}\b/g)?.map(normalized) || [];
    const jobRequestsCredential = /\b(certification|certified|qualification|member|membership|part-qualified)\b/.test(jobText) ||
      acronyms.some((token) => jobText.includes(token));
    if (!jobRequestsCredential || !acronyms.some((token) => jobText.includes(token))) continue;
    add({
      id: `decisive-certification-${requirements.length + 1}`,
      text: certification,
      priority: "must",
      type: "certification",
      hiringImportance: 5,
      summaryValue: 5,
      coverage: "explicit",
      evidence: [],
      summaryEvidence: [{
        kind: "certification",
        certification,
        sourceExperienceId: "",
        sourceBulletIndexes: [],
        language: "",
        level: "",
        skill: "",
        educationId: "",
        projectId: "",
        value: "",
        basis: "",
        confidence: "high"
      }],
      sourceSkills: []
    });
  }

  const authorization = authorizationText(profile);
  if (authorization && /\b(work authori|right to work|sponsorship|visa)\b/.test(jobText)) {
    add({
      id: "decisive-work-authorization",
      text: authorization,
      priority: "must",
      type: "authorization",
      hiringImportance: 5,
      summaryValue: 5,
      coverage: "explicit",
      evidence: [],
      summaryEvidence: [{
        kind: "authorization",
        value: authorization,
        sourceExperienceId: "",
        sourceBulletIndexes: [],
        language: "",
        level: "",
        skill: "",
        certification: "",
        educationId: "",
        projectId: "",
        basis: "",
        confidence: "high"
      }],
      sourceSkills: []
    });
  }
  return requirements;
}

function classifyRequirements(requirements: EvidencePlan["requirements"], profile: BaseProfile, job?: JobDescription) {
  const sourceSkills = profileSkills(profile);
  const merged = [...requirements];
  for (const deterministic of deterministicRequirements(profile, job)) {
    const existing = merged.find((requirement) =>
      requirement.id === deterministic.id || normalized(requirement.text).includes(normalized(deterministic.text)) ||
      normalized(deterministic.text).includes(normalized(requirement.text))
    );
    if (existing) {
      existing.type = deterministic.type;
      existing.priority = "must";
      existing.hiringImportance = 5;
      existing.summaryValue = 5;
      existing.summaryEvidence = deterministic.summaryEvidence;
    } else {
      merged.push(deterministic);
    }
  }
  return merged.map((requirement) => {
    const matchingSkills = sourceSkills.filter((skill) =>
      textMatchScore(skill, requirement.text) >= 3
    );
    const evidence = evidenceForText(profile, requirement.text);
    const exact = matchingSkills.some((skill) =>
      normalized(requirement.text).includes(normalized(skill))
    );
    const baseline = BASELINE_SKILLS.find((entry) =>
      entry.terms.some((term) => normalized(requirement.text).includes(term))
    );
    const inferredType = !requirement.type || requirement.type === "other"
      ? requirementType(requirement.text)
      : requirement.type;
    const suppliedSummaryEvidence = sanitizeSummaryEvidence(requirement.summaryEvidence || [], profile);
    const industryEvidence = inferredIndustryEvidence({ ...requirement, type: inferredType }, profile);
    const languageEvidence = inferredType === "language"
      ? profile.languages
        .filter((entry) => normalized(requirement.text).includes(normalized(entry.language)))
        .map((entry): SummaryEvidenceReference => ({
          kind: "language",
          language: entry.language,
          level: entry.level,
          sourceExperienceId: "",
          sourceBulletIndexes: [],
          skill: "",
          certification: "",
          educationId: "",
          projectId: "",
          value: "",
          basis: "",
          confidence: "high"
        }))
      : [];
    const certificationEvidence = inferredType === "certification"
      ? profile.certifications
        .filter((entry) => textMatchScore(entry, requirement.text) >= 3)
        .map((entry): SummaryEvidenceReference => ({
          kind: "certification",
          certification: entry,
          sourceExperienceId: "",
          sourceBulletIndexes: [],
          language: "",
          level: "",
          skill: "",
          educationId: "",
          projectId: "",
          value: "",
          basis: "",
          confidence: "high"
        }))
      : [];
    const summaryEvidence = Array.from(new Map([
      ...suppliedSummaryEvidence,
      ...industryEvidence,
      ...languageEvidence,
      ...certificationEvidence,
      ...matchingSkills.map((skill): SummaryEvidenceReference => ({
        kind: "skill",
        skill,
        sourceExperienceId: "",
        sourceBulletIndexes: [],
        language: "",
        level: "",
        certification: "",
        educationId: "",
        projectId: "",
        value: "",
        basis: "",
        confidence: "high"
      })),
      ...evidence.map((reference): SummaryEvidenceReference => ({
        kind: "experience",
        ...reference,
        language: "",
        level: "",
        skill: "",
        certification: "",
        educationId: "",
        projectId: "",
        value: "",
        basis: "",
        confidence: "high"
      }))
    ].map((reference) => [summaryEvidenceKey(reference), reference])).values());
    const supported = matchingSkills.length || evidence.length || summaryEvidence.length;
    return {
      ...requirement,
      type: inferredType,
      hiringImportance: requirement.priority === "must"
        ? Math.max(4, requirement.hiringImportance || 3)
        : requirement.hiringImportance || 3,
      summaryValue: ["language", "certification", "license", "authorization"].includes(inferredType)
        ? Math.max(4, requirement.summaryValue || 2)
        : requirement.summaryValue || 2,
      coverage: supported
        ? exact || suppliedSummaryEvidence.length || languageEvidence.length || certificationEvidence.length
          ? "explicit" as const
          : "supported-equivalent" as const
        : baseline ? "inferred-baseline" as const : "unsupported" as const,
      evidence,
      summaryEvidence,
      sourceSkills: matchingSkills
    };
  });
}

function enrichPlanSkills(
  selected: EvidencePlan["skills"],
  requirements: EvidencePlan["requirements"],
  profile: BaseProfile,
  job?: JobDescription,
  pageTarget: "one" | "two" = "one"
): EvidencePlan["skills"] {
  const source = profileSkills(profile);
  const sourceByName = new Map(source.map((skill) => [normalized(skill), skill]));
  const result = new Map<string, EvidencePlan["skills"][number]>();
  const add = (
    skill: string,
    provenance: SkillProvenance,
    requirementIds: string[] = [],
    sourceSkills: string[] = [],
    evidence = evidenceForText(profile, skill)
  ) => {
    const key = normalized(skill);
    const prior = result.get(key);
    result.set(key, {
      skill,
      category: provenance === "inferred-baseline" ? "Professional Skills" : categoryForSkill(profile, sourceSkills[0] || skill),
      requirementIds: Array.from(new Set([...(prior?.requirementIds || []), ...requirementIds])),
      evidence: prior?.evidence.length ? prior.evidence : evidence,
      provenance: prior?.provenance === "explicit" ? "explicit" : provenance,
      sourceSkills: Array.from(new Set([...(prior?.sourceSkills || []), ...sourceSkills]))
    });
  };

  for (const skill of selected) {
    const canonical = sourceByName.get(normalized(skill.skill));
    if (canonical) add(canonical, "explicit", skill.requirementIds, [canonical], skill.evidence);
  }
  for (const requirement of requirements.filter((item) =>
    item.priority !== "supporting" && item.coverage !== "unsupported"
  )) {
    for (const sourceSkill of requirement.sourceSkills) {
      const canonical = sourceByName.get(normalized(sourceSkill));
      if (canonical) add(
        canonical,
        requirement.coverage === "explicit" ? "explicit" : "equivalent",
        [requirement.id],
        [canonical],
        requirement.evidence
      );
    }
  }

  const jobText = `${job?.title || ""} ${job?.description || ""}`;
  const budget = pageTarget === "two" ? { target: 24, maximum: 36 } : { target: 16, maximum: 24 };

  // Infer a catalog skill (unless the source already covers it) with requirement
  // links where the JD references it.
  const alreadyCovered = (entry: { skill: string; terms: readonly string[] }) =>
    result.has(normalized(entry.skill)) ||
    source.some((skill) =>
      matchesTerm(skill, entry.skill) ||
      entry.terms.some((term) => matchesTerm(skill, term))
    );
  const addInferred = (entry: { skill: string; terms: readonly string[] }) => {
    if (alreadyCovered(entry)) return;
    const requirementIds = requirements
      .filter((requirement) => entry.terms.some((term) => matchesTerm(requirement.text, term)))
      .map((requirement) => requirement.id);
    add(entry.skill, "inferred-baseline", requirementIds, [], []);
  };

  // Source-skill ranking comes first so real, evidence-backed skills win the
  // budget before any inferred skills top it up.
  const excelRequested = /\bexcel\b/i.test(jobText);
  const ranked = source.map((skill, index) => {
    const requirementScore = requirements.reduce((best, requirement) => {
      const priority = requirement.priority === "must" ? 40 : requirement.priority === "important" ? 25 : 10;
      return Math.max(best, textMatchScore(skill, requirement.text) * priority);
    }, 0);
    const jobScore = textMatchScore(skill, jobText) * 20;
    const excelScore = excelRequested && EXCEL_ECOSYSTEM.some((term) => normalized(skill).includes(term)) ? 180 : 0;
    const evidenceScore = evidenceForText(profile, skill).length ? 20 : 0;
    return { skill, index, score: requirementScore + jobScore + excelScore + evidenceScore };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  for (const candidate of ranked.filter((item) => item.score >= 25)) {
    if (result.size >= budget.maximum) break;
    add(candidate.skill, "explicit", [], [candidate.skill]);
  }
  for (const sourceSkill of source) {
    if (result.size >= budget.maximum || result.has(normalized(sourceSkill))) continue;
    const relatedToIncludedSkill = [...result.values()].some((included) => {
      const left = normalized(sourceSkill);
      const right = normalized(included.skill);
      return left.includes(right) || right.includes(left);
    });
    if (relatedToIncludedSkill) add(sourceSkill, "explicit", [], [sourceSkill]);
  }
  // Retain broadly even on weak matches: keep most source skills rather than
  // pruning a profile down to a token list.
  const minimum = Math.min(source.length, 12);
  const target = Math.min(budget.target, source.length);
  for (const candidate of ranked) {
    if (result.size >= Math.max(minimum, target) || result.size >= budget.maximum) break;
    add(candidate.skill, "explicit", [], [candidate.skill]);
  }

  // Universal baselines are always eligible — Excel/MS Office and core soft skills
  // belong on essentially any resume regardless of whether the JD names them.
  // Added after source skills so real evidence keeps priority on the budget.
  for (const baseline of BASELINE_SKILLS) {
    if (result.size >= budget.maximum) break;
    addInferred(baseline);
  }

  // Top up with target-domain inferred skills (and transferable/adjacent bridges).
  // Driven by the TARGET role; falls back to source domains when the JD is thin.
  const targetDomains = detectTargetDomains(job);
  const sourceDomains = detectSourceDomains(profile);
  const seededDomains = new Set<SkillDomain>(targetDomains.length ? targetDomains : sourceDomains);
  for (const sourceDomain of sourceDomains) {
    const bridges = DOMAIN_ADJACENCY[sourceDomain] || [];
    if (targetDomains.some((target) => target === sourceDomain || bridges.includes(target) ||
      (DOMAIN_ADJACENCY[target] || []).includes(sourceDomain))) {
      seededDomains.add(sourceDomain);
    }
  }
  for (const domain of seededDomains) {
    for (const entry of DOMAIN_SKILLS[domain]) {
      if (result.size >= budget.maximum) break;
      addInferred(entry);
    }
  }

  return [...result.values()];
}

function requirementIdsForText(requirements: EvidencePlan["requirements"], text: string): string[] {
  return requirements
    .filter((requirement) => requirement.coverage !== "unsupported" && textMatchScore(requirement.text, text) >= 2)
    .map((requirement) => requirement.id);
}

function rankBullet(text: string, job?: JobDescription): number {
  const jobText = `${job?.title || ""} ${job?.description || ""}`;
  const relevance = textMatchScore(text, jobText) * 20;
  const domain = IMPORTANT_EVIDENCE_TERMS.filter((term) => normalized(text).includes(term)).length * 20;
  const metric = /\d/.test(text) ? 12 : 0;
  const stakeholder = /\b(stakeholder|client|customer|partner|present|train|communicat)\w*/i.test(text) ? 8 : 0;
  return relevance + domain + metric + stakeholder;
}

function objectivePriority(
  objective: EvidencePlan["roles"][number]["bulletObjectives"][number],
  requirements: EvidencePlan["requirements"],
  text: string,
  job?: JobDescription
): number {
  const requirementWeight = objective.requirementIds.reduce((best, id) => {
    const priority = requirements.find((requirement) => requirement.id === id)?.priority;
    return Math.max(best, priority === "must" ? 1000 : priority === "important" ? 500 : 100);
  }, 0);
  return requirementWeight + rankBullet(text, job);
}

function recovery(
  code: string,
  severity: Recovery["severity"],
  section = "",
  sourceExperienceId = ""
): Recovery {
  return { code, severity, section, sourceExperienceId };
}

function validIndexes(indexes: number[], bulletCount: number): number[] {
  return Array.from(new Set(indexes.filter((index) => index >= 0 && index < bulletCount)));
}

function defaultPositioningMode(
  fit: EvidencePlan["fit"],
  dimensions: NonNullable<EvidencePlan["fitDimensions"]>,
  profile: BaseProfile
): NonNullable<NonNullable<EvidencePlan["summaryBlueprint"]>["positioningMode"]> {
  if (seniorProfile(profile) && fit === "direct") return "executive";
  const educationLed = !profile.experiences.length || (
    Boolean(profile.projects?.length) &&
    profile.experiences.every((role) => /\b(intern|internship|trainee|student)\b/i.test(role.role))
  );
  if (educationLed) return "education-led";
  if (dimensions.functionFit === "change") return fit === "stretch" ? "transferable" : "transition";
  if (dimensions.functionFit === "adjacent") return "adjacent-identity";
  if (fit === "direct" && dimensions.evidenceStrength === "strong") return "target-identity";
  return "transferable";
}

function buildSummaryBlueprint(
  input: EvidencePlan,
  requirements: EvidencePlan["requirements"],
  claims: EvidencePlan["summaryClaims"],
  profile: BaseProfile,
  job?: JobDescription
): NonNullable<EvidencePlan["summaryBlueprint"]> {
  const supportedPriority = requirements.filter((requirement) =>
    requirement.priority !== "supporting" &&
    ["explicit", "supported-equivalent"].includes(requirement.coverage)
  );
  const evidenceStrength: NonNullable<EvidencePlan["fitDimensions"]>["evidenceStrength"] =
    supportedPriority.length >= 3 ? "strong" : supportedPriority.length ? "partial" : "weak";
  const targetFunction = normalized(profile.targetRole || profile.experiences[0]?.role || "");
  const titleFunctionDirect = Boolean(targetFunction) && normalized(job?.title || "").includes(targetFunction);
  const regulatedFunctionChange = /\b(kyc|aml|anti-money|compliance)\b/i.test(`${job?.title || ""} ${job?.description || ""}`) &&
    !profile.experiences.some((role) => /\b(kyc|aml|anti-money|compliance)\b/i.test(role.role));
  const dimensions = {
    functionFit: regulatedFunctionChange
      ? "change" as const
      : titleFunctionDirect
      ? "direct" as const
      : input.fitDimensions?.functionFit || (input.fit === "direct" ? "direct" : input.fit === "stretch" ? "change" : "adjacent"),
    industryFit: input.fitDimensions?.industryFit || "unknown",
    seniorityFit: input.fitDimensions?.seniorityFit || "unknown",
    evidenceStrength
  };
  const decisiveRequirementIds = requirements.filter(decisiveRequirement).map((requirement) => requirement.id);
  const positioningMode = defaultPositioningMode(input.fit, dimensions, profile);
  const safeMode = dimensions.functionFit === "change" && ["target-identity", "adjacent-identity"].includes(positioningMode)
    ? "transition"
    : positioningMode;
  const targetIdentityAllowed = ["target-identity", "executive"].includes(safeMode) &&
    dimensions.functionFit === "direct" &&
    evidenceStrength === "strong";
  return {
    positioningMode: safeMode,
    positioningStrategy: input.summaryBlueprint?.positioningStrategy ||
      (safeMode === "transition"
        ? "Lead with the proven background framed in the job's required competencies, and explicitly frame the move into the target function."
        : safeMode === "education-led"
          ? "Lead with relevant education, projects, and demonstrated technical evidence, described in the job's own terminology."
          : "Lead with the job's headline required competencies, backed by the strongest supported evidence for the target role."),
    targetIdentityAllowed,
    decisiveRequirementIds,
    claimIds: claims.map((claim) => claim.id)
  };
}

function safeEvidencePlan(profile: BaseProfile, job?: JobDescription): EvidencePlan {
  const pageTarget = pageTargetFor(profile);
  const roles = profile.experiences
    .filter((role) => role.bullets.length)
    .map((role) => ({
      sourceExperienceId: role.id,
      include: true,
      originalTitle: role.role,
      proposedTitle: role.role,
      titleEvidence: [],
      titleConfidence: "high" as const,
      bulletObjectives: role.bullets.map((_bullet, index) => ({
        id: `safe-${role.id}-${index}`,
        objective: "Preserve supported source evidence",
        sourceBulletIndexes: [index],
        requirementIds: []
      }))
    }));
  const firstRole = roles[0];
  const summaryClaims = firstRole ? [{
    id: "safe-summary-1",
    objective: "Position the candidate using verified source experience",
    evidence: [{ kind: "experience" as const, sourceExperienceId: firstRole.sourceExperienceId, sourceBulletIndexes: [0] }],
    requirementIds: [],
    mandatory: false,
    provenance: "explicit" as const
  }] : [];
  return evidencePlanSchema.parse({
    version: "3",
    fit: "stretch",
    requirements: [],
    summaryClaims,
    roles,
    skills: enrichPlanSkills([], [], profile, job, pageTarget),
    certifications: profile.certifications,
    sectionOrder: sectionOrderFor(profile),
    pageTarget
  });
}

export function sanitizeEvidencePlan(
  input: EvidencePlan,
  profile: BaseProfile,
  job?: JobDescription
): { plan: EvidencePlan; recoveries: Recovery[] } {
  const recoveries: Recovery[] = [];
  const sourceById = new Map(profile.experiences.map((role) => [role.id, role]));
  const sourceSkills = new Map(profileSkills(profile).map((skill) => [normalized(skill), skill]));
  const requirements = classifyRequirements(input.requirements, profile, job);
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const seenRoles = new Set<string>();

  const roles = input.roles.flatMap((rolePlan) => {
    const source = sourceById.get(rolePlan.sourceExperienceId);
    if (!source || seenRoles.has(rolePlan.sourceExperienceId)) {
      recoveries.push(recovery(
        source ? "duplicate-role-plan-dropped" : "unknown-role-plan-dropped",
        "dropped",
        "experience",
        rolePlan.sourceExperienceId
      ));
      return [];
    }
    seenRoles.add(source.id);
    const titleEvidence = rolePlan.titleEvidence.flatMap((reference) => {
      if (reference.sourceExperienceId !== source.id) return [];
      const indexes = validIndexes(reference.sourceBulletIndexes, source.bullets.length);
      return indexes.length ? [{ sourceExperienceId: source.id, sourceBulletIndexes: indexes }] : [];
    });
    const canReframe = rolePlan.proposedTitle.trim() &&
      normalized(rolePlan.proposedTitle) !== normalized(source.role) &&
      rolePlan.titleConfidence === "high" &&
      titleEvidence.length > 0;
    const proposedTitle = canReframe ? rolePlan.proposedTitle.trim() : source.role;
    if (normalized(rolePlan.originalTitle) !== normalized(source.role)) {
      recoveries.push(recovery("original-title-restored", "corrected", "experience", source.id));
    }
    if (normalized(rolePlan.proposedTitle) !== normalized(source.role) && !canReframe) {
      recoveries.push(recovery("title-reframe-reverted", "corrected", "experience", source.id));
    }
    let bulletObjectives = rolePlan.bulletObjectives.flatMap((objective) => {
      const indexes = validIndexes(objective.sourceBulletIndexes, source.bullets.length);
      if (!indexes.length) {
        recoveries.push(recovery("invalid-bullet-objective-dropped", "dropped", "experience", source.id));
        return [];
      }
      if (indexes.length !== objective.sourceBulletIndexes.length) {
        recoveries.push(recovery("invalid-bullet-index-removed", "corrected", "experience", source.id));
      }
      return [{
        ...objective,
        sourceBulletIndexes: indexes,
        requirementIds: (objective.requirementIds || [])
          .filter((id) => requirementIds.has(id))
          .concat(requirementIdsForText(requirements, indexes.map((index) => source.bullets[index] || "").join(" ")))
          .filter((id, index, entries) => entries.indexOf(id) === index)
      }];
    });
    let include = rolePlan.include;
    if (include && !bulletObjectives.length && source.bullets.length) {
      bulletObjectives = source.bullets.map((_bullet, index) => ({
        id: `restored-${source.id}-${index}`,
        objective: "Preserve supported source evidence",
        sourceBulletIndexes: [index],
        requirementIds: requirementIdsForText(requirements, source.bullets[index] || "")
      }));
      recoveries.push(recovery("source-bullet-objectives-restored", "degraded", "experience", source.id));
    } else if (include && !bulletObjectives.length) {
      include = false;
      recoveries.push(recovery("empty-source-role-excluded", "dropped", "experience", source.id));
    }
    if (include) {
      const selectedIndexes = new Set(bulletObjectives.flatMap((objective) => objective.sourceBulletIndexes));
      for (const requirement of requirements.filter((item) =>
        item.priority !== "supporting" &&
        ["explicit", "supported-equivalent"].includes(item.coverage)
      )) {
        for (const reference of requirement.evidence.filter((item) => item.sourceExperienceId === source.id)) {
          for (const index of validIndexes(reference.sourceBulletIndexes, source.bullets.length)) {
            const existing = bulletObjectives.find((objective) => objective.sourceBulletIndexes.includes(index));
            if (existing) {
              existing.requirementIds = Array.from(new Set([...existing.requirementIds, requirement.id]));
            } else if (!selectedIndexes.has(index)) {
              selectedIndexes.add(index);
              bulletObjectives.push({
                id: `requirement-${requirement.id}-${source.id}-${index}`,
                objective: `Represent supported requirement: ${requirement.text}`,
                sourceBulletIndexes: [index],
                requirementIds: [requirement.id]
              });
              recoveries.push(recovery("requirement-bullet-objective-restored", "corrected", "experience", source.id));
            }
          }
        }
      }
    }
    if (profile.experiences.length === 1 && include && source.bullets.length >= 4) {
      const selected = new Set(bulletObjectives.flatMap((objective) => objective.sourceBulletIndexes));
      const desired = Math.min(6, source.bullets.length);
      for (const candidate of source.bullets
        .map((text, index) => ({ text, index, score: rankBullet(text, job) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)) {
        if (selected.size >= Math.max(4, desired)) break;
        if (selected.has(candidate.index)) continue;
        selected.add(candidate.index);
        bulletObjectives.push({
          id: `coverage-${source.id}-${candidate.index}`,
          objective: "Preserve high-value source evidence for job coverage",
          sourceBulletIndexes: [candidate.index],
          requirementIds: requirementIdsForText(requirements, candidate.text)
        });
        recoveries.push(recovery("relevant-bullet-objective-restored", "corrected", "experience", source.id));
      }
      bulletObjectives = bulletObjectives
        .sort((left, right) =>
          objectivePriority(right, requirements, source.bullets[right.sourceBulletIndexes[0]!] || "", job) -
          objectivePriority(left, requirements, source.bullets[left.sourceBulletIndexes[0]!] || "", job)
        )
        .slice(0, 6);
    }
    return [{
      ...rolePlan,
      include,
      originalTitle: source.role,
      proposedTitle,
      titleEvidence: canReframe ? titleEvidence : [],
      titleConfidence: "high" as const,
      bulletObjectives
    }];
  });

  const summaryClaims = input.summaryClaims.flatMap((claim) => {
    const evidence = sanitizeSummaryEvidence(claim.evidence, profile);
    if (!evidence.length) {
      recoveries.push(recovery("unsupported-summary-claim-dropped", "dropped", "summary"));
      return [];
    }
    return [{
      ...claim,
      evidence,
      requirementIds: (claim.requirementIds || []).filter((id) => requirementIds.has(id)),
      mandatory: Boolean(claim.mandatory) || (claim.requirementIds || []).some((id) =>
        requirements.some((requirement) => requirement.id === id && decisiveRequirement(requirement))
      ),
      provenance: evidence.some((reference) => reference.kind === "inference")
        ? "inferred-context" as const
        : claim.provenance === "equivalent" ? "equivalent" as const : "explicit" as const
    }];
  });

  for (const requirement of requirements.filter(decisiveRequirement)) {
    const existing = summaryClaims.find((claim) => (claim.requirementIds || []).includes(requirement.id));
    if (existing) {
      existing.mandatory = true;
      existing.evidence = Array.from(new Map([
        ...existing.evidence,
        ...(requirement.summaryEvidence || [])
      ].map((reference) => [summaryEvidenceKey(reference), reference])).values());
      continue;
    }
    summaryClaims.push({
      id: `mandatory-summary-${requirement.id}`,
      objective: `Include decisive matched requirement: ${requirement.text}`,
      evidence: requirement.summaryEvidence || [],
      requirementIds: [requirement.id],
      mandatory: true,
      provenance: "explicit"
    });
    recoveries.push(recovery("mandatory-summary-claim-restored", "corrected", "summary"));
  }

  for (const requirement of requirements
    .filter((item) =>
      item.coverage !== "unsupported" &&
      (item.summaryEvidence || []).length > 0
    )
    .sort((left, right) =>
      (right.summaryValue || 0) - (left.summaryValue || 0) ||
      (right.hiringImportance || 0) - (left.hiringImportance || 0)
    )) {
    if (summaryClaims.length >= 4) break;
    if (summaryClaims.some((claim) =>
      (claim.requirementIds || []).includes(requirement.id) ||
      claim.evidence.some((reference) =>
        (requirement.summaryEvidence || []).some((candidate) =>
          summaryEvidenceAllowed(reference, candidate) || summaryEvidenceAllowed(candidate, reference)
        )
      )
    )) continue;
    summaryClaims.push({
      id: `restored-summary-${requirement.id}`,
      objective: `Represent supported job requirement: ${requirement.text}`,
      evidence: requirement.summaryEvidence || [],
      requirementIds: [requirement.id],
      mandatory: decisiveRequirement(requirement),
      provenance: (requirement.summaryEvidence || []).some((reference) => reference.kind === "inference")
        ? "inferred-context"
        : "explicit"
    });
    recoveries.push(recovery("requirement-summary-claim-restored", "corrected", "summary"));
  }

  const sanitizedSkills = input.skills.flatMap((skill) => {
    const canonical = sourceSkills.get(normalized(skill.skill));
    if (!canonical && skill.provenance !== "inferred-baseline") {
      recoveries.push(recovery("unsupported-skill-dropped", "dropped", "skills"));
      return [];
    }
    const requirementIdsForSkill = skill.requirementIds.filter((id) => requirementIds.has(id));
    if (requirementIdsForSkill.length !== skill.requirementIds.length) {
      recoveries.push(recovery("unknown-skill-requirement-removed", "corrected", "skills"));
    }
    const evidence = skill.evidence.flatMap((reference) => {
      const source = sourceById.get(reference.sourceExperienceId);
      if (!source) return [];
      const indexes = validIndexes(reference.sourceBulletIndexes, source.bullets.length);
      return indexes.length ? [{ sourceExperienceId: source.id, sourceBulletIndexes: indexes }] : [];
    });
    return [{
      ...skill,
      skill: canonical || skill.skill,
      requirementIds: requirementIdsForSkill,
      evidence,
      provenance: canonical ? skill.provenance : "inferred-baseline" as const,
      sourceSkills: canonical ? Array.from(new Set([...(skill.sourceSkills || []), canonical])) : []
    }];
  });
  const pageTarget = pageTargetFor(profile);
  const skills = enrichPlanSkills(sanitizedSkills, requirements, profile, job, pageTarget);
  if (skills.length > sanitizedSkills.length) {
    recoveries.push(recovery("source-skill-coverage-expanded", "corrected", "skills"));
  }

  const usableRole = roles.find((role) => role.include && role.bulletObjectives.length);
  if (usableRole && summaryClaims.length < 2) {
    for (const objective of usableRole.bulletObjectives) {
      if (summaryClaims.length >= 2) break;
      const index = objective.sourceBulletIndexes[0];
      if (index === undefined || summaryClaims.some((claim) =>
        claim.evidence.some((reference) =>
          (reference.kind || "experience") === "experience" &&
          reference.sourceExperienceId === usableRole.sourceExperienceId &&
          (reference.sourceBulletIndexes || []).includes(index)
        )
      )) continue;
      summaryClaims.push({
        id: `restored-summary-${usableRole.sourceExperienceId}-${index}`,
        objective: "Position the candidate using high-value verified source experience",
        evidence: [{
          kind: "experience",
          sourceExperienceId: usableRole.sourceExperienceId,
          sourceBulletIndexes: [index]
        }],
        requirementIds: objective.requirementIds || [],
        mandatory: false,
        provenance: "explicit"
      });
      recoveries.push(recovery("source-summary-objective-restored", "degraded", "summary"));
    }
  }

  let plan = evidencePlanSchema.parse({
    ...input,
    version: "3",
    requirements,
    summaryClaims: summaryClaims
      .sort((left, right) => Number(right.mandatory) - Number(left.mandatory))
      .slice(0, 4),
    summaryBlueprint: buildSummaryBlueprint(input, requirements, summaryClaims, profile, job),
    roles,
    skills,
    certifications: profile.certifications,
    sectionOrder: sectionOrderFor(profile),
    pageTarget
  });
  const usableRoles = plan.roles.filter((role) => role.include && role.bulletObjectives.length);
  if (!usableRoles.length) {
    plan = safeEvidencePlan(profile, job);
    recoveries.push(recovery("safe-plan-used", "degraded"));
  }
  return { plan, recoveries };
}

export function validateEvidencePlan(plan: EvidencePlan, profile: BaseProfile): string[] {
  const findings: string[] = [];
  const roles = new Map(profile.experiences.map((role) => [role.id, role]));
  const skills = profileSkillSet(profile);
  const requirementIds = new Set(plan.requirements.map((requirement) => requirement.id));

  const validateReference = (sourceExperienceId: string, indexes: number[], label: string) => {
    const source = roles.get(sourceExperienceId);
    if (!source) {
      findings.push(`${label} references unknown role ${sourceExperienceId}`);
      return;
    }
    if (indexes.some((index) => index < 0 || index >= source.bullets.length)) {
      findings.push(`${label} references an invalid bullet index`);
    }
  };

  for (const claim of plan.summaryClaims) {
    if (!claim.evidence.length) findings.push(`Summary claim ${claim.id} has no evidence`);
    if ((claim.requirementIds || []).some((id) => !requirementIds.has(id))) {
      findings.push(`Summary claim ${claim.id} references an unknown requirement`);
    }
    for (const reference of claim.evidence) {
      if (!summaryEvidenceText(reference, profile)) {
        findings.push(`Summary claim ${claim.id} has invalid ${reference.kind} evidence`);
      }
      if (reference.kind === "inference" && (reference.confidence || "high") !== "high") {
        findings.push(`Summary claim ${claim.id} uses low-confidence inference`);
      }
    }
  }
  for (const requirementId of plan.summaryBlueprint?.decisiveRequirementIds || []) {
    if (!plan.summaryClaims.some((claim) => claim.mandatory && (claim.requirementIds || []).includes(requirementId))) {
      findings.push(`Decisive requirement ${requirementId} has no mandatory summary claim`);
    }
  }
  for (const rolePlan of plan.roles) {
    const source = roles.get(rolePlan.sourceExperienceId);
    if (!source) {
      findings.push(`Role plan references unknown role ${rolePlan.sourceExperienceId}`);
      continue;
    }
    if (rolePlan.originalTitle !== source.role) findings.push(`Role plan changed original title for ${source.id}`);
    if (rolePlan.proposedTitle !== source.role && (rolePlan.titleConfidence !== "high" || !rolePlan.titleEvidence.length)) {
      findings.push(`Title change for ${source.id} lacks high-confidence evidence`);
    }
    if (rolePlan.titleEvidence.some((reference) => reference.sourceExperienceId !== source.id)) {
      findings.push(`Title change for ${source.id} cites a different role`);
    }
    rolePlan.titleEvidence.forEach((reference) => validateReference(reference.sourceExperienceId, reference.sourceBulletIndexes, `Title for ${source.id}`));
    for (const objective of rolePlan.bulletObjectives) {
      if (!objective.sourceBulletIndexes.length) findings.push(`Bullet objective ${objective.id} has no source indexes`);
      validateReference(source.id, objective.sourceBulletIndexes, `Bullet objective ${objective.id}`);
    }
  }
  for (const skill of plan.skills) {
    const allowedInference = skill.provenance === "inferred-baseline" &&
      INFERRED_SKILL_ALLOWED.has(normalized(skill.skill));
    if (!skills.has(normalized(skill.skill)) && !allowedInference) findings.push(`Unsupported skill ${skill.skill}`);
    if (skill.requirementIds.some((id) => !requirementIds.has(id))) findings.push(`Skill ${skill.skill} references an unknown requirement`);
    skill.evidence.forEach((reference) => validateReference(reference.sourceExperienceId, reference.sourceBulletIndexes, `Skill ${skill.skill}`));
  }
  for (const certification of plan.certifications) {
    if (!profile.certifications.some((source) => normalized(source) === normalized(certification))) {
      findings.push(`Unsupported certification ${certification}`);
    }
  }
  return findings;
}

function summaryAlreadyFitsBlueprint(profile: BaseProfile, job: JobDescription, plan: EvidencePlan): boolean {
  const base = normalized(profile.summary);
  if (!base) return false;
  const mandatoryCovered = plan.summaryClaims
    .filter((claim) => claim.mandatory)
    .every((claim) => claim.evidence.some((reference) => {
      const evidence = normalized(summaryEvidenceText(reference, profile));
      return evidence && (base.includes(evidence) || textMatchScore(evidence, base) >= 4);
    }));
  const titleAligned = textMatchScore(job.title, profile.summary) >= 3 ||
    plan.summaryBlueprint?.positioningMode === "transferable";
  return mandatoryCovered && titleAligned;
}

export function validateWriterOutput(
  output: WriterOutput,
  plan: EvidencePlan,
  profile?: BaseProfile,
  job?: JobDescription
): string[] {
  const findings: string[] = [];
  const rolePlans = new Map(plan.roles.map((role) => [role.sourceExperienceId, role]));
  const approvedSkills = new Set(plan.skills.map((skill) => normalized(skill.skill)));
  const approvedCertifications = new Set(plan.certifications.map(normalized));
  const summaryPlans = new Map(plan.summaryClaims.map((claim) => [claim.id, claim]));
  const outputClaimIds = new Set(output.summaryClaims.map((claim) => claim.id));
  for (const claim of plan.summaryClaims.filter((entry) => entry.mandatory)) {
    if (!outputClaimIds.has(claim.id)) findings.push(`Writer omitted planned summary claim ${claim.id}`);
  }

  for (const claim of output.summaryClaims) {
    const planned = summaryPlans.get(claim.id);
    if (!planned) {
      findings.push(`Writer added unplanned summary claim ${claim.id}`);
      continue;
    }
    if (claim.evidence.some((reference) =>
      !planned.evidence.some((allowed) => summaryEvidenceAllowed(reference, allowed))
    )) {
      findings.push(`Summary claim ${claim.id} cites unplanned evidence`);
    }
    if (!normalized(output.summary).includes(normalized(claim.text))) {
      findings.push(`Summary claim ${claim.id} text does not appear in the summary`);
    }
    if ((claim.provenance || "explicit") !== (planned.provenance || "explicit")) {
      findings.push(`Summary claim ${claim.id} changed provenance`);
    }
  }
  for (const claim of plan.summaryClaims.filter((entry) => entry.mandatory)) {
    if (!output.summaryClaims.some((entry) => entry.id === claim.id)) {
      findings.push(`Writer omitted mandatory summary claim ${claim.id}`);
    }
  }
  if (!plan.summaryBlueprint?.targetIdentityAllowed &&
    normalized(output.summary).startsWith(normalized(job?.title || "")) &&
    normalized(job?.title || "")) {
    findings.push("Summary claims the target identity despite transition-safe positioning");
  }
  if (profile && job && normalized(output.summary) === normalized(profile.summary) &&
    !summaryAlreadyFitsBlueprint(profile, job, plan)) {
    findings.push("Writer reused the generic base summary despite job-specific summary evidence");
  }
  for (const role of output.roles) {
    const planned = rolePlans.get(role.sourceExperienceId);
    if (!planned || !planned.include) {
      findings.push(`Writer returned unplanned role ${role.sourceExperienceId}`);
      continue;
    }
    if (![planned.originalTitle, planned.proposedTitle].includes(role.displayTitle)) {
      findings.push(`Writer returned an unapproved title for ${role.sourceExperienceId}`);
    }
    const allowedIndexes = new Set(planned.bulletObjectives.flatMap((objective) => objective.sourceBulletIndexes));
    for (const bullet of role.bullets) {
      if (!bullet.sourceBulletIndexes.length || bullet.sourceBulletIndexes.some((index) => !allowedIndexes.has(index))) {
        findings.push(`Writer bullet ${bullet.id} cites unplanned evidence`);
      }
    }
  }
  const outputRoleIds = new Set(output.roles.map((role) => role.sourceExperienceId));
  for (const role of plan.roles.filter((role) => role.include)) {
    if (!outputRoleIds.has(role.sourceExperienceId)) findings.push(`Writer omitted planned role ${role.sourceExperienceId}`);
  }
  const outputSkills = output.skillCategories.flatMap((category) => category.skills);
  for (const skill of outputSkills) if (!approvedSkills.has(normalized(skill))) findings.push(`Writer added unplanned skill ${skill}`);
  for (const certification of output.certifications) {
    if (!approvedCertifications.has(normalized(certification))) findings.push(`Writer added unplanned certification ${certification}`);
  }
  return findings;
}

function skillCategoriesFromPlan(plan: EvidencePlan): Array<{ name: string; skills: string[] }> {
  const categories = new Map<string, string[]>();
  for (const skill of plan.skills) {
    const name = skill.category.trim() || "Skills";
    const entries = categories.get(name) || [];
    if (!entries.some((entry) => normalized(entry) === normalized(skill.skill))) entries.push(skill.skill);
    categories.set(name, entries);
  }
  return [...categories].map(([name, skills]) => ({ name, skills }));
}

// Honor the skills-writer call's grouping while enforcing that it only regroups
// plan-approved skills: drop any skill the plan did not approve, place any approved
// skill the writer missed into a catch-all, and fall back to the deterministic
// plan grouping if the writer output is empty or covers nothing valid.
function skillCategoriesFromWriter(
  categories: Array<{ name: string; skills: string[] }>,
  plan: EvidencePlan
): Array<{ name: string; skills: string[] }> {
  const approved = new Map(plan.skills.map((skill) => [normalized(skill.skill), skill.skill]));
  const placed = new Set<string>();
  const result: Array<{ name: string; skills: string[] }> = [];
  for (const category of categories) {
    const name = category.name.trim() || "Skills";
    const skills: string[] = [];
    for (const skill of category.skills) {
      const key = normalized(skill);
      const canonical = approved.get(key);
      if (!canonical || placed.has(key)) continue;
      placed.add(key);
      skills.push(canonical);
    }
    if (skills.length) {
      const existing = result.find((entry) => normalized(entry.name) === normalized(name));
      if (existing) existing.skills.push(...skills);
      else result.push({ name, skills });
    }
  }
  if (!result.length) return skillCategoriesFromPlan(plan);
  const missing = plan.skills.filter((skill) => !placed.has(normalized(skill.skill)));
  if (missing.length) {
    const catchAll = result.find((entry) => normalized(entry.name) === "skills") || result[result.length - 1]!;
    catchAll.skills.push(...missing.map((skill) => skill.skill));
  }
  return result;
}

function compactEvidenceText(reference: SummaryEvidenceReference, profile: BaseProfile): string {
  const text = summaryEvidenceText(reference, profile).trim();
  if (!text) return "";
  if ((reference.kind || "experience") === "language") {
    const source = profile.languages.find((entry) => normalized(entry.language) === normalized(reference.language || ""));
    return source ? `${source.language} (${source.level})` : text;
  }
  if ((reference.kind || "experience") === "experience" && (reference.sourceBulletIndexes || []).length > 1) {
    return text
      .split(/(?<=[.!?])\s+/)
      .slice(0, 3)
      .map((sentence) => sentence.replace(/[.!?]+$/, "").trim())
      .filter(Boolean)
      .join("; ");
  }
  return text.split(/(?<=[.!?])\s+/)[0]!.replace(/[.!?]+$/, "").trim();
}

function fallbackSummary(
  plan: EvidencePlan,
  profile: BaseProfile,
  job: JobDescription
): { summary: string; summaryClaims: WriterOutput["summaryClaims"] } {
  const currentRole = profile.experiences[0]?.role || profile.targetRole || "Professional";
  const degree = profile.education[0]?.degree || "Graduate";
  const mode = plan.summaryBlueprint?.positioningMode || "transferable";
  const opener = mode === "target-identity" && plan.summaryBlueprint?.targetIdentityAllowed
    ? `${job.title} with evidence-backed experience aligned to the role.`
    : mode === "executive"
      ? `${currentRole} bringing senior leadership and commercial evidence to ${job.title} opportunities.`
      : mode === "education-led"
        ? `${degree} targeting ${job.title} opportunities through relevant academic and project evidence.`
        : mode === "transition"
          ? `${currentRole} transitioning into ${job.title} roles through directly transferable experience.`
          : `${currentRole} targeting ${job.title} opportunities with relevant, source-backed experience.`;

  const summaryClaims = plan.summaryClaims.slice(0, 4).flatMap((claim) => {
    const text = claim.evidence
      .map((reference) => compactEvidenceText(reference, profile))
      .find((candidate) => candidate && !candidate.toLocaleLowerCase().includes("unknown")) || "";
    return text ? [{
      id: claim.id,
      text,
      evidence: claim.evidence,
      requirementIds: claim.requirementIds || [],
      provenance: claim.provenance || "explicit"
    }] : [];
  }).filter((claim, index, claims) =>
    claims.findIndex((entry) => normalized(entry.text) === normalized(claim.text)) === index
  );
  // Weave the proof points into one flowing sentence rather than emitting each as a
  // choppy standalone fragment ("English (Native/C2). HRIS & Employee Data Management.").
  const proofSentence = (claims: typeof summaryClaims): string => {
    const points = claims.map((claim) => claim.text.replace(/[.!?]+$/, "").trim()).filter(Boolean);
    if (!points.length) return "";
    const list = points.length === 1
      ? points[0]!
      : `${points.slice(0, -1).join(", ")} and ${points[points.length - 1]}`;
    return `Relevant strengths for the ${job.title} role include ${list}.`;
  };
  let summary = [opener, proofSentence(summaryClaims)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  // Keep this rare deterministic fallback in the same 55-80 band as the LLM summary
  // gate (summaryOutputUsable) so a fallback summary doesn't read noticeably shorter.
  if (summary.split(/\s+/).length < 55) {
    summary += ` These verified strengths provide a focused foundation for the core responsibilities and working context of the ${job.title} position.`;
  }
  if (summary.split(/\s+/).length > 80) {
    const mandatory = summaryClaims.filter((claim) =>
    plan.summaryClaims.some((planned) => planned.id === claim.id && planned.mandatory)
    );
    const optional = summaryClaims.filter((claim) => !mandatory.some((entry) => entry.id === claim.id));
    const selected = [...mandatory, ...optional].slice(0, Math.max(1, 3 - mandatory.length + mandatory.length));
    summary = [opener, proofSentence(selected)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { summary, summaryClaims: selected };
  }
  return { summary, summaryClaims };
}

function alignClaimText(summary: string, claimText: string, objective: string): string {
  if (normalized(summary).includes(normalized(claimText))) return claimText.trim();
  const sentences = summary
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const ranked = sentences
    .map((sentence) => ({
      sentence,
      score: Math.max(textMatchScore(claimText, sentence), textMatchScore(objective, sentence))
    }))
    .sort((left, right) => right.score - left.score);
  return (ranked[0]?.score || 0) >= 1.5 ? ranked[0]!.sentence : "";
}

function stripUnsupportedGapSentences(summary: string): string {
  return summary
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) =>
      !/\b(not evidenced|not explicitly|no evidence|without claiming|does not have|lacks?)\b/i.test(sentence)
    )
    .join(" ")
    .trim();
}

function summaryOutputUsable(
  output: Pick<WriterOutput, "summary" | "summaryClaims">,
  plan: EvidencePlan,
  profile: BaseProfile,
  job: JobDescription
): boolean {
  const wordCount = output.summary.trim().split(/\s+/).filter(Boolean).length;
  // The prompt asks for exactly 3 sentences, 55-68 words; allow a little slack either
  // side of that band rather than rejecting close-but-not-exact LLM output.
  if (wordCount < 45 || wordCount > 80 || !output.summaryClaims.length) return false;
  if (unsupportedSummaryNumbers(output.summary, profile).length) return false;
  if (normalized(output.summary) === normalized(profile.summary) && !summaryAlreadyFitsBlueprint(profile, job, plan)) return false;
  if (plan.summaryClaims.filter((claim) => claim.mandatory)
    .some((claim) => !output.summaryClaims.some((entry) => entry.id === claim.id))) return false;
  return output.summaryClaims.every((claim) =>
    normalized(output.summary).includes(normalized(claim.text)) &&
    plan.summaryClaims.some((planned) =>
      planned.id === claim.id &&
      claim.evidence.every((reference) => planned.evidence.some((allowed) =>
        summaryEvidenceAllowed(reference, allowed)
      ))
    )
  );
}

function sourceBackedWriter(
  plan: EvidencePlan,
  profile: BaseProfile,
  job: JobDescription,
  preferred?: WriterOutput
): WriterOutput {
  const sourceById = new Map(profile.experiences.map((role) => [role.id, role]));
  const fallback = fallbackSummary(plan, profile, job);
  const preserveSummary = preferred && summaryOutputUsable(preferred, plan, profile, job);
  return {
    summary: preserveSummary ? preferred.summary : fallback.summary,
    summaryClaims: preserveSummary ? preferred.summaryClaims : fallback.summaryClaims,
    roles: plan.roles.filter((role) => role.include).flatMap((rolePlan) => {
      const source = sourceById.get(rolePlan.sourceExperienceId);
      if (!source) return [];
      const indexes = Array.from(new Set(rolePlan.bulletObjectives.flatMap((objective) => objective.sourceBulletIndexes)));
      return [{
        sourceExperienceId: source.id,
        displayTitle: rolePlan.proposedTitle || source.role,
        bullets: indexes.flatMap((index) => source.bullets[index] ? [{
          id: `source-${source.id}-${index}`,
          text: source.bullets[index]!,
          sourceBulletIndexes: [index]
        }] : [])
      }];
    }),
    skillCategories: skillCategoriesFromPlan(plan),
    skillEvidence: plan.skills.map((skill) => ({
      skill: skill.skill,
      evidence: skill.evidence,
      provenance: skill.provenance,
      sourceSkills: skill.sourceSkills,
      requirementIds: skill.requirementIds
    })),
    certifications: profile.certifications
  };
}

function sanitizeWriterOutput(
  output: WriterOutput,
  plan: EvidencePlan,
  profile: BaseProfile,
  job: JobDescription
): { writer: WriterOutput; recoveries: Recovery[] } {
  const recoveries: Recovery[] = [];
  const candidateSummary = stripUnsupportedGapSentences(output.summary);
  if (normalized(candidateSummary) !== normalized(output.summary)) {
    recoveries.push(recovery("unsupported-gap-language-removed", "corrected", "summary"));
  }
  const sourceById = new Map(profile.experiences.map((role) => [role.id, role]));
  const outputById = new Map(output.roles.map((role) => [role.sourceExperienceId, role]));
  const summaryPlanById = new Map(plan.summaryClaims.map((claim) => [claim.id, claim]));
  const inferredSkills = plan.skills.filter((skill) => skill.provenance === "inferred-baseline");
  const summaryClaims = output.summaryClaims.flatMap((claim) => {
    const planned = summaryPlanById.get(claim.id);
    if (!planned) {
      recoveries.push(recovery("unplanned-summary-claim-dropped", "dropped", "summary"));
      return [];
    }
    const evidence = sanitizeSummaryEvidence(claim.evidence, profile)
      .filter((reference) => planned.evidence.some((allowed) =>
        summaryEvidenceAllowed(reference, allowed)
      ));
    if (!evidence.length) {
      recoveries.push(recovery("invalid-summary-citation-dropped", "dropped", "summary"));
      return [];
    }
    const alignedText = alignClaimText(candidateSummary, claim.text, planned.objective);
    if (!alignedText) {
      recoveries.push(recovery("summary-claim-text-missing", "dropped", "summary"));
      return [];
    }
    if (normalized(alignedText) !== normalized(claim.text)) {
      recoveries.push(recovery("summary-claim-text-aligned", "corrected", "summary"));
    }
    return [{
      ...claim,
      text: alignedText,
      evidence,
      requirementIds: planned.requirementIds || [],
      provenance: planned.provenance || "explicit"
    }];
  });

  const roles = plan.roles.filter((role) => role.include).flatMap((rolePlan) => {
    const source = sourceById.get(rolePlan.sourceExperienceId);
    if (!source) return [];
    const written = outputById.get(source.id);
    const approvedTitle = rolePlan.proposedTitle || source.role;
    let displayTitle = written?.displayTitle?.trim() || approvedTitle;
    if (![source.role, approvedTitle].some((title) => normalized(title) === normalized(displayTitle))) {
      displayTitle = approvedTitle;
      recoveries.push(recovery("writer-title-restored", "corrected", "experience", source.id));
    }
    const allowedIndexes = new Set(rolePlan.bulletObjectives.flatMap((objective) => objective.sourceBulletIndexes));
    let bullets = (written?.bullets || []).flatMap((bullet) => {
      const indexes = validIndexes(bullet.sourceBulletIndexes, source.bullets.length)
        .filter((index) => allowedIndexes.has(index));
      if (!indexes.length) {
        recoveries.push(recovery("writer-bullet-dropped", "dropped", "experience", source.id));
        return [];
      }
      const citedSource = indexes.map((index) => source.bullets[index] || "").join(" ");
      const leaksInference = inferredSkills.some((skill) =>
        normalized(bullet.text).includes(normalized(skill.skill)) &&
        !normalized(citedSource).includes(normalized(skill.skill))
      );
      if (leaksInference) {
        recoveries.push(recovery("inferred-skill-removed-from-bullet", "corrected", "experience", source.id));
        return [{
          ...bullet,
          text: source.bullets[indexes[0]!]!,
          sourceBulletIndexes: indexes
        }];
      }
      return [{ ...bullet, sourceBulletIndexes: indexes }];
    });
    const coveredIndexes = new Set(bullets.flatMap((bullet) => bullet.sourceBulletIndexes));
    for (const index of Array.from(allowedIndexes)) {
      if (coveredIndexes.has(index) || !source.bullets[index]) continue;
      bullets.push({
        id: `source-${source.id}-${index}`,
        text: source.bullets[index]!,
        sourceBulletIndexes: [index]
      });
      coveredIndexes.add(index);
      recoveries.push(recovery("omitted-planned-bullet-restored", "corrected", "experience", source.id));
    }
    if (!bullets.length) {
      bullets = Array.from(allowedIndexes).flatMap((index) => source.bullets[index] ? [{
        id: `source-${source.id}-${index}`,
        text: source.bullets[index]!,
        sourceBulletIndexes: [index]
      }] : []);
      recoveries.push(recovery("source-bullets-restored", "degraded", "experience", source.id));
    }
    if (!written) recoveries.push(recovery("omitted-role-restored", "degraded", "experience", source.id));
    return [{ sourceExperienceId: source.id, displayTitle, bullets }];
  });

  let summary = candidateSummary;
  let finalSummaryClaims: WriterOutput["summaryClaims"] = summaryClaims;
  // Allow inferred-baseline skills that are explicit JD requirements — using JD vocabulary in the
  // summary is intentional alignment, not fabrication. Still block skills the JD doesn't mention.
  const jdText = normalized(`${job?.title || ""} ${job?.description || ""}`);
  const inferredSummaryClaim = inferredSkills.some((skill) =>
    !jdText.includes(normalized(skill.skill)) &&
    normalized(summary).includes(normalized(skill.skill)) &&
    !normalized(profile.summary).includes(normalized(skill.skill))
  );
  const unsupportedNumbers = unsupportedSummaryNumbers(summary, profile);
  if (!summary || !summaryClaims.length || inferredSummaryClaim || unsupportedNumbers.length) {
    const fallback = sourceBackedWriter(plan, profile, job);
    summary = fallback.summary;
    finalSummaryClaims = fallback.summaryClaims;
    recoveries.push(recovery(
      inferredSummaryClaim
        ? "inferred-skill-removed-from-summary"
        : unsupportedNumbers.length
          ? "unsupported-summary-number-removed"
          : "source-summary-restored",
      "degraded",
      "summary"
    ));
  }
  for (const planned of plan.summaryClaims) {
    if (finalSummaryClaims.length >= 2) break;
    if (finalSummaryClaims.some((claim) => claim.id === planned.id)) continue;
    const text = planned.evidence.map((reference) => compactEvidenceText(reference, profile)).find(Boolean) || "";
    if (!text || textMatchScore(text, summary) >= 4) continue;
    summary = `${summary.replace(/\s+$/, "")} ${text.replace(/[.!?]+$/, "")}.`
      .replace(/\s+/g, " ")
      .trim();
    finalSummaryClaims.push({
      id: planned.id,
      text,
      evidence: planned.evidence,
      requirementIds: planned.requirementIds || [],
      provenance: planned.provenance || "explicit"
    });
    recoveries.push(recovery("summary-proof-point-restored", "corrected", "summary"));
  }
  if (output.certifications.some((certification) =>
    !profile.certifications.some((source) => normalized(source) === normalized(certification))
  )) {
    recoveries.push(recovery("writer-certifications-ignored", "dropped", "certifications"));
  }

  return {
    writer: {
      summary,
      summaryClaims: finalSummaryClaims,
      roles,
      skillCategories: skillCategoriesFromWriter(output.skillCategories, plan),
      skillEvidence: plan.skills.map((skill) => ({
        skill: skill.skill,
        evidence: skill.evidence,
        provenance: skill.provenance,
        sourceSkills: skill.sourceSkills,
        requirementIds: skill.requirementIds
      })),
      certifications: profile.certifications
    },
    recoveries
  };
}

function evaluationFromDeterministic(cv: TailoredCv, profile: BaseProfile, job: JobDescription): ResumeEvaluation {
  const evaluation = evaluateTailoredCv(profile, job, cv);
  return {
    evaluatorVersion: "2",
    checks: evaluation.checks.map((finding) => ({
      id: finding.id,
      dimension: finding.dimension,
      status: finding.status,
      label: finding.label,
      detail: finding.detail,
      section: "",
      sourceExperienceId: ""
    })),
    scores: evaluation.scores,
    hardFailureIds: evaluation.hardFailures.map((failure) => failure.id)
  };
}

function assembleCv(
  profile: BaseProfile,
  job: JobDescription,
  plan: EvidencePlan,
  output: WriterOutput,
  runId: string,
  stageDurations: StageMetric[],
  repairCount: number,
  recoveries: Recovery[] = []
): TailoredCv {
  const sourceById = new Map(profile.experiences.map((source) => [source.id, source]));
  const outputById = new Map(output.roles.map((role) => [role.sourceExperienceId, role]));
  const categories = output.skillCategories
    .filter((category) => category.name.trim() && category.skills.length)
    .map((category) => [category.name, category.skills] as const);
  const skills = Array.from(new Set(categories.flatMap(([, entries]) => entries)));
  const now = new Date().toISOString();

  return tailoredCvSchema.parse({
    id: crypto.randomUUID(),
    baseProfileId: profile.id,
    job,
    contact: profile.contact,
    summary: output.summary,
    summaryClaims: output.summaryClaims.map((claim) => ({
      ...claim,
      evidenceStatus: claim.provenance === "inferred-context" ||
        claim.evidence.some((reference) => reference.kind === "inference")
        ? "needs-review"
        : "verified"
    })),
    experiences: plan.roles.filter((role) => role.include).flatMap((rolePlan) => {
      const source = sourceById.get(rolePlan.sourceExperienceId);
      const written = outputById.get(rolePlan.sourceExperienceId);
      if (!source || !written) return [];
      const displayTitle = written.displayTitle.trim() || source.role;
      const verifiedTitle = displayTitle === source.role ||
        (displayTitle === rolePlan.proposedTitle && rolePlan.titleConfidence === "high" && rolePlan.titleEvidence.length > 0);
      return [{
        id: crypto.randomUUID(),
        sourceExperienceId: source.id,
        company: source.company,
        role: verifiedTitle ? displayTitle : source.role,
        originalRole: source.role,
        titleEvidenceStatus: displayTitle === source.role ? "unchanged" : verifiedTitle ? "verified-reframe" : "needs-review",
        startDate: source.startDate,
        endDate: source.endDate,
        bullets: written.bullets.map((bullet) => ({
          id: bullet.id || crypto.randomUUID(),
          text: bullet.text,
          sourceBulletIndexes: bullet.sourceBulletIndexes,
          evidenceStatus: "verified"
        })),
        sourceBulletIndexes: Array.from(new Set(written.bullets.flatMap((bullet) => bullet.sourceBulletIndexes)))
      }];
    }),
    education: profile.education,
    skills,
    skillEvidence: output.skillEvidence.map((skill) => ({
      ...skill,
      evidenceStatus: skill.provenance === "inferred-baseline" ? "needs-review" : "verified"
    })),
    skillCategories: Object.fromEntries(categories),
    certifications: profile.certifications,
    languages: profile.languages,
    sectionOrder: plan.sectionOrder.length ? plan.sectionOrder : profile.sectionOrder,
    style: profile.style,
    dismissedChecks: [],
    unsupportedClaims: output.summaryClaims
      .filter((claim) => claim.provenance === "inferred-context" ||
        claim.evidence.some((reference) => reference.kind === "inference"))
      .map((claim) => ({
        section: "summary",
        text: claim.text,
        reason: "AI-inferred context requires review before use."
      })),
    evidencePlan: plan,
    readiness: "needs-source-update",
    pipeline: {
      pipelineVersion: PIPELINE_VERSION,
      runId,
      stages: stageDurations,
      aiCallCount: 3 + repairCount,
      repairCount,
      recoveries
    },
    createdAt: now,
    updatedAt: now
  });
}

async function timed<T>(name: string, stages: StageMetric[], fn: () => Promise<T>, generator?: Generator): Promise<T> {
  const started = Date.now();
  if (generator) generator.lastUsage = undefined;
  let attempts = 0;
  try {
    while (attempts < 2) {
      attempts += 1;
      try {
        return await fn();
      } catch (error) {
        if (attempts >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`${name} failed`);
  } finally {
    stages.push({ name, durationMs: Date.now() - started, attempts, ...generator?.lastUsage });
  }
}

function appendWriterValidation(evaluation: ResumeEvaluation, findings: string[]): ResumeEvaluation {
  if (!findings.length) return evaluation;
  const checks: EvaluationFinding[] = findings.map((detail, index) => ({
    id: `writer-evidence-${index + 1}`,
    dimension: "truthfulness",
    status: "fail",
    label: "Generated content exceeded the evidence plan",
    detail,
    section: "",
    sourceExperienceId: ""
  }));
  return {
    ...evaluation,
    checks: [...evaluation.checks, ...checks],
    hardFailureIds: [...evaluation.hardFailureIds, ...checks.map((check) => check.id)]
  };
}

function appendRecoveries(evaluation: ResumeEvaluation, recoveries: Recovery[]): ResumeEvaluation {
  if (!recoveries.length) return evaluation;
  const labels: Record<string, string> = {
    "title-reframe-reverted": "Proposed title was restored to the official title",
    "unsupported-skill-dropped": "An unsupported optional skill was omitted",
    "safe-plan-used": "A conservative evidence plan was used",
    "source-bullets-restored": "Source bullets were restored",
    "source-summary-restored": "A source-backed summary was restored",
    "writer-certifications-ignored": "Generated certification changes were ignored"
  };
  return {
    ...evaluation,
    checks: [
      ...evaluation.checks,
      ...recoveries.map((item, index) => ({
        id: `recovery-${item.code}-${index + 1}`,
        dimension: item.section === "experience" && item.code.includes("title") ? "appropriateness" as const : "truthfulness" as const,
        status: "warn" as const,
        label: labels[item.code] || "Generated content was safely corrected",
        detail: `Fyxor applied the ${item.code} recovery and continued generation.`,
        section: item.section,
        sourceExperienceId: item.sourceExperienceId
      }))
    ]
  };
}

function mergeCritic(evaluation: ResumeEvaluation, critic: typeof llmCriticSchema._output): ResumeEvaluation {
  const criticFindings: EvaluationFinding[] = critic.findings.map(({ mustFix: _mustFix, patchInstruction, ...finding }) => ({
    ...finding,
    dimension: finding.dimension === "credibility" ? "truthfulness" : finding.dimension,
    section: finding.section || "",
    sourceExperienceId: finding.sourceExperienceId || "",
    detail: `${finding.detail}${patchInstruction ? ` Fix: ${patchInstruction}` : ""}`
  }));
  return {
    ...evaluation,
    checks: [...evaluation.checks, ...criticFindings],
    scores: {
      ...evaluation.scores,
      relevance: Math.round(critic.scores.relevance * 20),
      readability: Math.round(critic.scores.readability * 20),
      appropriateness: Math.round(critic.scores.appropriateness * 20)
    },
    hardFailureIds: [
      ...evaluation.hardFailureIds,
      ...critic.findings.filter((finding) => finding.mustFix).map((finding) => finding.id)
    ]
  };
}

export async function generateUnifiedCv(input: {
  generator: Generator;
  profile: BaseProfile;
  job: JobDescription;
  runId: string;
  provider?: string;
  model?: string;
  onProgress?: StageProgress;
}): Promise<TailoredCv> {
  const { generator, profile, job, runId, provider = "", model = "", onProgress = () => {} } = input;
  const stages: StageMetric[] = [];
  const recoveries: Recovery[] = [];

  await onProgress("planning", 15);
  const rawPlan = evidencePlanSchema.parse(await timed("planning", stages, () => generator.generate({
    name: "evidence_plan",
    schema: llmEvidencePlanSchema,
    instructions: evidencePlannerPrompt,
    payload: { profile, job, summaryEvidenceCatalogue: summaryEvidenceCatalogue(profile) }
  }), generator));
  let sanitizedPlan = sanitizeEvidencePlan(rawPlan, profile, job);
  let plan = sanitizedPlan.plan;
  recoveries.push(...sanitizedPlan.recoveries);
  if (validateEvidencePlan(plan, profile).length) {
    plan = safeEvidencePlan(profile, job);
    recoveries.push(recovery("safe-plan-used", "degraded"));
  }

  await onProgress("writing", 40);
  const summaryOut = llmSummaryWriterSchema.parse(await timed("writing_summary", stages, () => generator.generate({
    name: "resume_summary",
    schema: llmSummaryWriterSchema,
    instructions: summaryWriterPrompt,
    payload: {
      plan,
      job,
      requirements: plan.requirements,
      summaryBlueprint: plan.summaryBlueprint,
      summaryClaims: plan.summaryClaims,
      summaryEvidenceCatalogue: summaryEvidenceCatalogue(profile)
    }
  }), generator));
  const experienceOut = llmExperienceWriterSchema.parse(await timed("writing_experience", stages, () => generator.generate({
    name: "resume_experience",
    schema: llmExperienceWriterSchema,
    instructions: experienceWriterPrompt,
    payload: { plan, evidence: profile, job }
  }), generator));
  const skillsOut = llmSkillsWriterSchema.parse(await timed("writing_skills", stages, () => generator.generate({
    name: "resume_skills",
    schema: llmSkillsWriterSchema,
    instructions: skillsWriterPrompt,
    payload: { skills: plan.skills, job }
  }), generator));
  let rawWriter: WriterOutput = {
    summary: summaryOut.summary,
    summaryClaims: summaryOut.summaryClaims,
    roles: experienceOut.roles,
    skillCategories: skillsOut.skillCategories,
    skillEvidence: plan.skills.map((skill) => ({
      skill: skill.skill,
      evidence: skill.evidence,
      provenance: skill.provenance,
      sourceSkills: skill.sourceSkills,
      requirementIds: skill.requirementIds
    })),
    certifications: profile.certifications
  };
  let sanitizedWriter = sanitizeWriterOutput(rawWriter, plan, profile, job);
  let writer = sanitizedWriter.writer;
  recoveries.push(...sanitizedWriter.recoveries);

  await onProgress("validating", 60);
  let cv = assembleCv(profile, job, plan, writer, runId, stages, 0, recoveries);
  let evaluation = appendRecoveries(
    appendWriterValidation(evaluationFromDeterministic(cv, profile, job), validateWriterOutput(writer, plan, profile, job)),
    recoveries
  );

  await onProgress("critic", 75);
  let critic = llmCriticSchema.parse(await timed("critic", stages, () => generator.generate({
    name: "resume_critic",
    schema: llmCriticSchema,
    instructions: resumeCriticPrompt,
    payload: { plan, cv, deterministicFindings: evaluation.checks }
  }), generator));
  evaluation = mergeCritic(evaluation, critic);

  const mustRepair = evaluation.hardFailureIds.length > 0 ||
    critic.scores.relevance < 4 || critic.scores.credibility < 4 || critic.scores.appropriateness < 4;
  if (mustRepair) {
    await onProgress("repairing", 85);
    rawWriter = llmResumeWriterSchema.parse(await timed("repairing", stages, () => generator.generate({
      name: "resume_repair",
      schema: llmResumeWriterSchema,
      instructions: resumeRepairPrompt,
      payload: { plan, current: writer, deterministicFindings: evaluation.checks, critic }
    }), generator));
    sanitizedWriter = sanitizeWriterOutput(rawWriter, plan, profile, job);
    writer = sanitizedWriter.writer;
    recoveries.push(...sanitizedWriter.recoveries);
    cv = assembleCv(profile, job, plan, writer, runId, stages, 1, recoveries);
    evaluation = appendRecoveries(
      appendWriterValidation(evaluationFromDeterministic(cv, profile, job), validateWriterOutput(writer, plan, profile, job)),
      recoveries
    );
    const semanticMustFix = critic.findings.filter((finding) => finding.mustFix);
    if (semanticMustFix.length) {
      critic = llmCriticSchema.parse(await timed("critic_recheck", stages, () => generator.generate({
        name: "resume_critic_recheck",
        schema: llmCriticSchema,
        instructions: resumeCriticPrompt,
        payload: { plan, cv, priorFindings: semanticMustFix }
      }), generator));
      evaluation = mergeCritic(evaluation, critic);
    }
  }

  if (evaluation.hardFailureIds.length) {
    writer = sourceBackedWriter(plan, profile, job, writer);
    recoveries.push(recovery("final-source-fallback-used", "degraded"));
    cv = assembleCv(profile, job, plan, writer, runId, stages, stages.some((stage) => stage.name === "repairing") ? 1 : 0, recoveries);
    evaluation = appendRecoveries(evaluationFromDeterministic(cv, profile, job), recoveries);
  }

  const readiness = evaluation.hardFailureIds.length ? "blocked" : "ready";
  await onProgress("completed", 100);
  return tailoredCvSchema.parse({
    ...cv,
    evaluation,
    readiness,
    pipeline: {
      ...cv.pipeline,
      provider,
      model,
      stages,
      aiCallCount: stages.filter((stage) => ["planning", "writing_summary", "writing_experience", "writing_skills", "critic", "repairing", "critic_recheck"].includes(stage.name)).length,
      repairCount: stages.some((stage) => stage.name === "repairing") ? 1 : 0,
      recoveries
    },
    updatedAt: new Date().toISOString()
  });
}

export async function regenerateUnifiedSection(input: {
  generator: Generator;
  profile: BaseProfile;
  cv: TailoredCv;
  section: "summary" | "experience" | "skills";
  experienceId?: string;
}): Promise<RegenerationPatch> {
  const { generator, profile, cv, section, experienceId } = input;
  const planResult = sanitizeEvidencePlan(evidencePlanSchema.parse(cv.evidencePlan), profile, cv.job);
  const plan = validateEvidencePlan(planResult.plan, profile).length ? safeEvidencePlan(profile, cv.job) : planResult.plan;
  const recoveries = [...planResult.recoveries];
  if (plan !== planResult.plan) recoveries.push(recovery("safe-plan-used", "degraded"));
  const stages: StageMetric[] = [];
  let rawWriter = llmResumeWriterSchema.parse(await timed("regeneration_write", stages, () => generator.generate({
    name: `regenerate_${section}`,
    schema: llmResumeWriterSchema,
    instructions: `${evidenceWriterPrompt}\nRegenerate only ${section}${experienceId ? ` for experience ${experienceId}` : ""}; copy all other mutable content exactly.`,
    payload: { plan, evidence: profile, currentCv: cv, section, experienceId }
  }), generator));
  let writerResult = sanitizeWriterOutput(rawWriter, plan, profile, cv.job);
  let writer = writerResult.writer;
  recoveries.push(...writerResult.recoveries);
  let generated = assembleCv(profile, cv.job, plan, writer, cv.pipeline.runId || crypto.randomUUID(), stages, 0, recoveries);
  let evaluation = appendRecoveries(
    appendWriterValidation(evaluationFromDeterministic(generated, profile, cv.job), validateWriterOutput(writer, plan, profile, cv.job)),
    recoveries
  );
  let critic = llmCriticSchema.parse(await timed("regeneration_critic", stages, () => generator.generate({
    name: `critic_${section}`,
    schema: llmCriticSchema,
    instructions: resumeCriticPrompt,
    payload: { plan, cv: generated, section, experienceId, deterministicFindings: evaluation.checks }
  }), generator));
  evaluation = mergeCritic(evaluation, critic);
  if (evaluation.hardFailureIds.length || critic.findings.some((finding) => finding.mustFix)) {
    rawWriter = llmResumeWriterSchema.parse(await timed("regeneration_repair", stages, () => generator.generate({
      name: `repair_${section}`,
      schema: llmResumeWriterSchema,
      instructions: `${resumeRepairPrompt}\nRepair only ${section}${experienceId ? ` for experience ${experienceId}` : ""}.`,
      payload: { plan, current: writer, deterministicFindings: evaluation.checks, critic }
    }), generator));
    writerResult = sanitizeWriterOutput(rawWriter, plan, profile, cv.job);
    writer = writerResult.writer;
    recoveries.push(...writerResult.recoveries);
    generated = assembleCv(profile, cv.job, plan, writer, cv.pipeline.runId || crypto.randomUUID(), stages, 1, recoveries);
    evaluation = appendRecoveries(
      appendWriterValidation(evaluationFromDeterministic(generated, profile, cv.job), validateWriterOutput(writer, plan, profile, cv.job)),
      recoveries
    );
  }
  if (evaluation.hardFailureIds.length) {
    writer = sourceBackedWriter(plan, profile, cv.job, writer);
    recoveries.push(recovery("final-source-fallback-used", "degraded", section, experienceId || ""));
    generated = assembleCv(profile, cv.job, plan, writer, cv.pipeline.runId || crypto.randomUUID(), stages, 1, recoveries);
    evaluation = appendRecoveries(evaluationFromDeterministic(generated, profile, cv.job), recoveries);
  }
  const readiness = evaluation.hardFailureIds.length ? "blocked" : "ready";

  if (section === "summary") {
    return regenerationPatchSchema.parse({
      section,
      summary: generated.summary,
      summaryClaims: generated.summaryClaims,
      evaluation,
      readiness
    });
  }
  if (section === "skills") {
    return regenerationPatchSchema.parse({
      section,
      skills: generated.skills,
      skillCategories: generated.skillCategories,
      skillEvidence: generated.skillEvidence,
      evaluation,
      readiness
    });
  }
  const currentExperience = cv.experiences.find((experience) => experience.id === experienceId);
  const replacement = currentExperience
    ? generated.experiences.find((experience) => experience.sourceExperienceId === currentExperience.sourceExperienceId)
    : undefined;
  if (!currentExperience || !replacement) throw new Error("Requested experience could not be regenerated");
  return regenerationPatchSchema.parse({
    section,
    experienceId: currentExperience.id,
    experience: { ...replacement, id: currentExperience.id },
    evaluation,
    readiness
  });
}
