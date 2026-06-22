import type { BaseProfile, JobDescription, TailoredCv } from "@cv-tailor/shared";

export type EvalDimension = "truthfulness" | "relevance" | "readability" | "ats" | "appropriateness";
export type EvalStatus = "pass" | "warn" | "fail";

export type ResumeEvalCheck = {
  id: string;
  dimension: EvalDimension;
  status: EvalStatus;
  label: string;
  detail: string;
  weight: number;
};

export type ResumeEvaluation = {
  checks: ResumeEvalCheck[];
  scores: Record<EvalDimension, number>;
  hardFailures: ResumeEvalCheck[];
};

const DIMENSIONS: EvalDimension[] = ["truthfulness", "relevance", "readability", "ats", "appropriateness"];
const GENERIC_PHRASES = [
  "responsible for",
  "worked on",
  "helped",
  "results-driven",
  "highly motivated",
  "hardworking",
  "team player"
];
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}+#.&/%'-]*/gu;
const NUMBER_RE = /(?<![\p{L}\p{N}])(?:[$€£]\s*)?\d+(?:[.,]\d+)*(?:\s*[%x×+])?(?![\p{L}\p{N}])/gu;

function plain(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalized(value: string): string {
  return plain(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}+#.&/%]+/gu, " ").replace(/\s+/g, " ").trim();
}

function words(value: string): string[] {
  return plain(value).match(WORD_RE) ?? [];
}

function numberTokens(value: string): string[] {
  return (plain(value).match(NUMBER_RE) ?? []).map((token) => token.replace(/\s+/g, "").toLocaleLowerCase());
}

function sentenceCount(value: string): number {
  const text = plain(value);
  if (!text) return 0;
  return text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim()).length || 1;
}

function skillSupported(skill: string, profile: BaseProfile): boolean {
  const needle = normalized(skill);
  if (!needle) return true;
  const evidence = [
    ...profile.skills,
    ...Object.values(profile.skillCategories).flat(),
    ...profile.experiences.flatMap((experience) => [experience.role, ...experience.bullets]),
    profile.summary,
    profile.rawText
  ].map(normalized).filter(Boolean);
  if (evidence.some((item) => item.includes(needle) || needle.includes(item))) return true;

  const tokens = new Set(needle.split(" ").filter((token) => token.length > 2));
  if (!tokens.size) return false;
  return evidence.some((item) => {
    const itemTokens = new Set(item.split(" "));
    const overlap = [...tokens].filter((token) => itemTokens.has(token)).length;
    return overlap >= Math.min(2, tokens.size);
  });
}

function supportedJobSkills(profile: BaseProfile, job: JobDescription): string[] {
  const jd = normalized(`${job.title} ${job.description}`);
  const candidates = Array.from(new Set([
    ...profile.skills,
    ...Object.values(profile.skillCategories).flat()
  ].map((skill) => skill.trim()).filter(Boolean)));
  return candidates.filter((skill) => jd.includes(normalized(skill)));
}

function check(
  id: string,
  dimension: EvalDimension,
  status: EvalStatus,
  label: string,
  detail: string,
  weight = 1
): ResumeEvalCheck {
  return { id, dimension, status, label, detail, weight };
}

export function evaluateTailoredCv(profile: BaseProfile, job: JobDescription, cv: TailoredCv): ResumeEvaluation {
  const checks: ResumeEvalCheck[] = [];
  const sourceById = new Map(profile.experiences.map((experience) => [experience.id, experience]));
  const outputText = [
    cv.summary,
    ...cv.experiences.flatMap((experience) => [experience.role, experience.company, ...experience.bullets]),
    ...cv.skills
  ].join("\n");
  const sourceText = JSON.stringify(profile);

  const unlinked = cv.experiences.filter((experience) => !sourceById.has(experience.sourceExperienceId));
  checks.push(check(
    "source-linkage",
    "truthfulness",
    unlinked.length ? "fail" : "pass",
    "Every tailored role links to a source role",
    unlinked.length ? `${unlinked.length} role(s) have a missing or unknown sourceExperienceId.` : "All tailored roles have a valid sourceExperienceId.",
    3
  ));

  const badCitations = cv.experiences.filter((experience) => {
    const source = sourceById.get(experience.sourceExperienceId);
    return !source || !experience.sourceBulletIndexes.length ||
      experience.sourceBulletIndexes.some((index) => index < 0 || index >= source.bullets.length);
  });
  checks.push(check(
    "bullet-citations",
    "truthfulness",
    badCitations.length ? "fail" : "pass",
    "Rewritten bullets retain source citations",
    badCitations.length ? `${badCitations.length} role(s) lack usable sourceBulletIndexes.` : "Every role cites valid source bullets.",
    3
  ));

  const changedFacts = cv.experiences.flatMap((experience) => {
    const source = sourceById.get(experience.sourceExperienceId);
    if (!source) return [];
    const fields = [
      normalized(experience.company) !== normalized(source.company) ? "company" : "",
      normalized(experience.startDate) !== normalized(source.startDate) ? "start date" : "",
      normalized(experience.endDate) !== normalized(source.endDate) ? "end date" : ""
    ].filter(Boolean);
    return fields.length ? [`${experience.role || source.role}: ${fields.join(", ")}`] : [];
  });
  checks.push(check(
    "fact-preservation",
    "truthfulness",
    changedFacts.length ? "fail" : "pass",
    "Employers and dates are preserved",
    changedFacts.length ? `Changed factual fields: ${changedFacts.join("; ")}.` : "Linked source employers and dates are unchanged.",
    3
  ));

  const sourceNumbers = new Set(numberTokens(sourceText));
  const unsupportedNumbers = Array.from(new Set(numberTokens(outputText).filter((token) => !sourceNumbers.has(token))));
  checks.push(check(
    "unsupported-numbers",
    "truthfulness",
    unsupportedNumbers.length ? "fail" : "pass",
    "No new numeric claims",
    unsupportedNumbers.length ? `Numbers absent from the base profile: ${unsupportedNumbers.join(", ")}.` : "All output numbers appear in the source profile.",
    3
  ));

  const unsupportedSkills = cv.skills.filter((skill) => !skillSupported(skill, profile));
  checks.push(check(
    "skill-evidence",
    "truthfulness",
    unsupportedSkills.length ? "warn" : "pass",
    "Skills are evidenced by the base profile",
    unsupportedSkills.length ? `Review unsupported or heavily reframed skills: ${unsupportedSkills.join(", ")}.` : "Every output skill has detectable source evidence.",
    2
  ));

  const relevantSourceSkills = supportedJobSkills(profile, job);
  const outputNormalized = normalized(outputText);
  const omittedRelevantSkills = relevantSourceSkills.filter((skill) => !outputNormalized.includes(normalized(skill)));
  const relevanceStatus: EvalStatus = relevantSourceSkills.length === 0
    ? "warn"
    : omittedRelevantSkills.length / relevantSourceSkills.length > 0.35 ? "warn" : "pass";
  checks.push(check(
    "supported-job-skill-coverage",
    "relevance",
    relevanceStatus,
    "Supported job-relevant skills are retained",
    relevantSourceSkills.length === 0
      ? "No exact overlap was found between profile skills and the job description; use a semantic or human relevance review."
      : omittedRelevantSkills.length
        ? `Omitted supported JD matches: ${omittedRelevantSkills.join(", ")}.`
        : "All exact profile-skill matches found in the JD are present in the tailored CV.",
    2
  ));

  const summaryWords = words(cv.summary).length;
  checks.push(check(
    "summary-length",
    "readability",
    summaryWords >= 35 && summaryWords <= 100 ? "pass" : "warn",
    "Summary is concise",
    `Summary length is ${summaryWords} words; the review band is 35–100.`,
    1
  ));

  const longBullets = cv.experiences.flatMap((experience) =>
    experience.bullets.filter((bullet) => words(bullet).length > 32).map((bullet) => `${experience.role}: ${words(bullet).length} words`)
  );
  checks.push(check(
    "bullet-length",
    "readability",
    longBullets.length ? "warn" : "pass",
    "Bullets are scannable",
    longBullets.length ? `Bullets over 32 words: ${longBullets.join("; ")}.` : "No bullet exceeds 32 words.",
    2
  ));

  const multiSentenceBullets = cv.experiences.flatMap((experience) =>
    experience.bullets.filter((bullet) => sentenceCount(bullet) > 1).map(() => experience.role)
  );
  checks.push(check(
    "single-sentence-bullets",
    "readability",
    multiSentenceBullets.length ? "warn" : "pass",
    "Bullets stay to one sentence",
    multiSentenceBullets.length ? `${multiSentenceBullets.length} bullet(s) contain multiple sentences.` : "All bullets are single-sentence.",
    1
  ));

  const lowerOutput = plain(outputText).toLocaleLowerCase();
  const genericHits = GENERIC_PHRASES.filter((phrase) => lowerOutput.includes(phrase));
  checks.push(check(
    "generic-language",
    "readability",
    genericHits.length ? "warn" : "pass",
    "Generic filler is avoided",
    genericHits.length ? `Generic phrases found: ${genericHits.join(", ")}.` : "No tracked generic filler phrases found.",
    1
  ));

  const htmlRemnants = /<[^>]+>/.test(outputText);
  checks.push(check(
    "plain-text-content",
    "ats",
    htmlRemnants ? "fail" : "pass",
    "Resume content contains no markup remnants",
    htmlRemnants ? "HTML-like tags remain in user-visible content." : "No HTML-like tags remain in the resume content.",
    2
  ));

  const contactMissing = [
    !cv.contact.name.trim() ? "name" : "",
    !cv.contact.email.trim() ? "email" : ""
  ].filter(Boolean);
  checks.push(check(
    "ats-contact",
    "ats",
    contactMissing.length ? "fail" : "pass",
    "Core contact fields are present",
    contactMissing.length ? `Missing: ${contactMissing.join(", ")}.` : "Name and email are present.",
    2
  ));

  const incompleteRoles = cv.experiences.filter((experience) =>
    !experience.role.trim() || !experience.company.trim() || !experience.bullets.some((bullet) => bullet.trim())
  );
  checks.push(check(
    "ats-role-structure",
    "ats",
    incompleteRoles.length ? "fail" : "pass",
    "Experience entries have parsable structure",
    incompleteRoles.length ? `${incompleteRoles.length} role(s) are missing a title, company, or bullet.` : "Every role has a title, company, and at least one bullet.",
    2
  ));

  const changedTitles = cv.experiences.flatMap((experience) => {
    const source = sourceById.get(experience.sourceExperienceId);
    return source && normalized(source.role) !== normalized(experience.role)
      ? [`${source.role} → ${experience.role}`]
      : [];
  });
  checks.push(check(
    "title-reframing",
    "appropriateness",
    changedTitles.length ? "warn" : "pass",
    "Changed job titles receive human review",
    changedTitles.length ? `Review title changes for accuracy: ${changedTitles.join("; ")}.` : "No source job titles were changed.",
    2
  ));

  const targetTitle = normalized(job.title);
  const summaryStartsAsTitle = Boolean(targetTitle) && normalized(cv.summary).startsWith(targetTitle);
  checks.push(check(
    "target-title-claim",
    "appropriateness",
    summaryStartsAsTitle ? "warn" : "pass",
    "Target title is framed as intent, not implied employment history",
    summaryStartsAsTitle
      ? "The summary opens with the exact target title; review wording so career changers do not appear to claim a role they have not held."
      : "The summary does not automatically present the target title as an established identity.",
    2
  ));

  const scores = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const dimensionChecks = checks.filter((item) => item.dimension === dimension);
    const total = dimensionChecks.reduce((sum, item) => sum + item.weight, 0);
    const earned = dimensionChecks.reduce((sum, item) => {
      if (item.status === "pass") return sum + item.weight;
      if (item.status === "warn") return sum + item.weight * 0.5;
      return sum;
    }, 0);
    return [dimension, total ? Math.round((earned / total) * 100) : 100];
  })) as Record<EvalDimension, number>;

  return {
    checks,
    scores,
    hardFailures: checks.filter((item) => item.status === "fail")
  };
}
