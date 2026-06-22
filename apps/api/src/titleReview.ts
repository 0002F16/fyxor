import type { BaseProfile, JobDescription, TailoredCv } from "@cv-tailor/shared";
import type { Generator } from "./openai.js";
import { experienceTitleReviewPrompt } from "./prompts.js";
import { llmExperienceTitleReviewSchema } from "./schemas.js";

type TitleDecision = {
  sourceExperienceId: string;
  title: string;
};

export function mergeReviewedExperienceTitles(
  cv: TailoredCv,
  decisions: TitleDecision[],
  allowedSourceExperienceIds?: ReadonlySet<string>
): TailoredCv {
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    counts.set(decision.sourceExperienceId, (counts.get(decision.sourceExperienceId) || 0) + 1);
  }

  const replacements = new Map<string, string>();
  for (const decision of decisions) {
    const sourceId = decision.sourceExperienceId;
    const title = decision.title.trim();
    if (!sourceId || !title || counts.get(sourceId) !== 1) continue;
    if (allowedSourceExperienceIds && !allowedSourceExperienceIds.has(sourceId)) continue;
    replacements.set(sourceId, title);
  }

  if (!replacements.size) return cv;
  let changed = false;
  const experiences = cv.experiences.map((experience) => {
    const replacement = replacements.get(experience.sourceExperienceId);
    if (!replacement || replacement === experience.role) return experience;
    changed = true;
    return { ...experience, role: replacement };
  });
  return changed ? { ...cv, experiences } : cv;
}

export async function reviewExperienceTitles(
  generatorOrFactory: Generator | (() => Generator),
  profile: BaseProfile,
  job: JobDescription,
  cv: TailoredCv,
  sourceExperienceIds?: ReadonlySet<string>
): Promise<TailoredCv> {
  const sourceById = new Map(profile.experiences.map((experience) => [experience.id, experience]));
  const candidates = cv.experiences
    .filter((experience) => !sourceExperienceIds || sourceExperienceIds.has(experience.sourceExperienceId))
    .map((experience) => {
      const source = sourceById.get(experience.sourceExperienceId);
      if (!source) return null;
      return {
        sourceExperienceId: source.id,
        currentTitle: experience.role,
        sourceRole: source.role,
        company: source.company,
        startDate: source.startDate,
        endDate: source.endDate,
        bullets: source.bullets
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  if (!candidates.length) return cv;

  try {
    const generator = typeof generatorOrFactory === "function" ? generatorOrFactory() : generatorOrFactory;
    const result = await generator.generate({
      name: "experience_title_review",
      schema: llmExperienceTitleReviewSchema,
      instructions: experienceTitleReviewPrompt,
      payload: {
        job,
        candidateSkills: profile.skills,
        experiences: candidates
      }
    });
    return mergeReviewedExperienceTitles(
      cv,
      result.titles,
      new Set(candidates.map((candidate) => candidate.sourceExperienceId))
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Experience title review failed; preserving existing titles. ${detail}`);
    return cv;
  }
}
