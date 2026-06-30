import { z } from "zod";
import {
  baseProfileSchema,
  contactSchema,
  evidencePlanSchema,
  experienceSchema,
  jobDescriptionSchema,
  projectSchema,
  summaryEvidenceReferenceSchema,
  tailoredCvSchema,
  tailoredExperienceSchema,
  unsupportedClaimSchema
} from "@cv-tailor/shared";

// Structured education for the LLM. No `id` — the shared schema's preprocess
// assigns ids when the result is folded back into a BaseProfile/TailoredCv.
export const llmEducationSchema = z.object({
  school: z.string(),
  degree: z.string(),
  location: z.string(),
  graduationDate: z.string(),
  gpa: z.string().optional(),
  honors: z.string(),
  coursework: z.array(z.string())
});

export const extractRequestSchema = z.object({
  text: z.string().min(30)
});
export const tailorRequestSchema = z.object({
  profile: baseProfileSchema,
  job: jobDescriptionSchema
});

export const exportRequestSchema = z.object({
  profile: baseProfileSchema,
  cv: tailoredCvSchema
});

export const categorizeRequestSchema = z.object({
  skills: z.array(z.string()).min(1),
  targetRole: z.string().default("")
});

// Skills-only structured-output result. Array (not record) skillCategories, like
// the other llm schemas — app.ts folds it back into the record + flat form.
export const llmSkillsSchema = z.object({
  skills: z.array(z.string()),
  skillCategories: z.array(z.object({ name: z.string(), skills: z.array(z.string()) }))
});

export const llmExperienceTitleReviewSchema = z.object({
  titles: z.array(z.object({
    sourceExperienceId: z.string(),
    title: z.string()
  }))
});

export const llmEvidencePlanSchema = evidencePlanSchema;

// Shared writer field shapes — reused by the combined writer schema (used by the
// repair stage) and by the per-section writer schemas below.
const writerSummaryClaimsField = z.array(z.object({
  id: z.string(),
  text: z.string(),
  evidence: z.array(summaryEvidenceReferenceSchema),
  requirementIds: z.array(z.string()).optional(),
  provenance: z.enum(["explicit", "equivalent", "inferred-context"]).optional()
}));
const writerRolesField = z.array(z.object({
  sourceExperienceId: z.string(),
  displayTitle: z.string(),
  bullets: z.array(z.object({
    id: z.string(),
    text: z.string(),
    sourceBulletIndexes: z.array(z.number().int().nonnegative())
  }))
}));
const writerSkillCategoriesField = z.array(z.object({
  name: z.string(),
  skills: z.array(z.string())
}));
const writerSkillEvidenceField = z.array(z.object({
  skill: z.string(),
  evidence: z.array(z.object({
    sourceExperienceId: z.string(),
    sourceBulletIndexes: z.array(z.number().int().nonnegative())
  })),
  provenance: z.enum(["explicit", "equivalent", "inferred-baseline"]).default("explicit"),
  sourceSkills: z.array(z.string()).default([]),
  requirementIds: z.array(z.string()).default([])
}));

export const llmResumeWriterSchema = z.object({
  summary: z.string(),
  summaryClaims: writerSummaryClaimsField,
  roles: writerRolesField,
  skillCategories: writerSkillCategoriesField,
  skillEvidence: writerSkillEvidenceField,
  certifications: z.array(z.string())
});

// Per-section writer schemas. The pipeline writes the summary, experience, and
// skills in three focused calls, then merges them back into a llmResumeWriterSchema
// shape for sanitization and assembly.
export const llmSummaryWriterSchema = z.object({
  summary: z.string(),
  summaryClaims: writerSummaryClaimsField
});

export const llmExperienceWriterSchema = z.object({
  roles: writerRolesField
});

export const llmSkillsWriterSchema = z.object({
  skillCategories: writerSkillCategoriesField
});

export const llmCriticSchema = z.object({
  scores: z.object({
    relevance: z.number().min(1).max(5),
    credibility: z.number().min(1).max(5),
    readability: z.number().min(1).max(5),
    appropriateness: z.number().min(1).max(5)
  }),
  findings: z.array(z.object({
    id: z.string(),
    dimension: z.enum(["truthfulness", "relevance", "readability", "ats", "appropriateness", "credibility"]),
    status: z.enum(["pass", "warn", "fail"]),
    label: z.string(),
    detail: z.string(),
    section: z.string().optional().default(""),
    sourceExperienceId: z.string().optional().default(""),
    mustFix: z.boolean(),
    patchInstruction: z.string()
  }))
});

export const llmBaseProfileSchema = z.object({
  id: z.string(),
  contact: contactSchema,
  targetRole: z.string(),
  summary: z.string(),
  experiences: z.array(experienceSchema),
  education: z.array(llmEducationSchema),
  projects: z.array(projectSchema).optional(),
  skills: z.array(z.string()),
  // Array (not record) form: the strict structured-output schema can't express an
  // open-ended object. app.ts folds this back into the record-shaped skillCategories.
  skillCategories: z.array(z.object({ name: z.string(), skills: z.array(z.string()) })),
  certifications: z.array(z.string()),
  languages: z.array(z.object({
    language: z.string(),
    level: z.string()
  })),
  rawText: z.string(),
  updatedAt: z.string()
});

export const llmTailoredCvSchema = z.object({
  id: z.string(),
  baseProfileId: z.string(),
  job: jobDescriptionSchema,
  contact: contactSchema,
  summary: z.string(),
  experiences: z.array(tailoredExperienceSchema),
  education: z.array(llmEducationSchema),
  skills: z.array(z.string()),
  // Array (not record) form, like llmBaseProfileSchema: strict structured output
  // can't express an open-ended object. app.ts folds this into skillCategories.
  skillCategories: z.array(z.object({ name: z.string(), skills: z.array(z.string()) })),
  unsupportedClaims: z.array(unsupportedClaimSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});
