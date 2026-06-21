import { z } from "zod";
import {
  baseProfileSchema,
  contactSchema,
  experienceSchema,
  jobDescriptionSchema,
  outputLanguageSchema,
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
  text: z.string().min(30),
  outputLanguage: outputLanguageSchema.default("en")
});
export const tailorRequestSchema = z.object({
  profile: baseProfileSchema,
  job: jobDescriptionSchema
});

export const exportRequestSchema = z.object({
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

export const llmBaseProfileSchema = z.object({
  id: z.string(),
  contact: contactSchema,
  targetRole: z.string(),
  outputLanguage: outputLanguageSchema,
  summary: z.string(),
  experiences: z.array(experienceSchema),
  education: z.array(llmEducationSchema),
  skills: z.array(z.string()),
  // Array (not record) form: the strict structured-output schema can't express an
  // open-ended object. app.ts folds this back into the record-shaped skillCategories.
  skillCategories: z.array(z.object({ name: z.string(), skills: z.array(z.string()) })),
  rawText: z.string(),
  updatedAt: z.string()
});

export const llmTailoredCvSchema = z.object({
  id: z.string(),
  baseProfileId: z.string(),
  job: jobDescriptionSchema,
  outputLanguage: outputLanguageSchema,
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
