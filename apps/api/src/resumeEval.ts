import {
  bulletText,
  type BaseProfile,
  type JobDescription,
  type SummaryEvidenceReference,
  type TailoredCv
} from "@cv-tailor/shared";

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

function authorizationText(profile: BaseProfile): string {
  return `${profile.summary}\n${profile.rawText}`
    .split(/\n|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .find((part) =>
      /\b(work authori[sz]ation|authori[sz]ed to work|right to work|without sponsorship|no sponsorship|visa|residence permit)\b/i.test(part)
    ) || "";
}

function summaryEvidenceValid(reference: SummaryEvidenceReference, profile: BaseProfile): boolean {
  const kind = reference.kind || "experience";
  if (kind === "experience") {
    const source = profile.experiences.find((entry) => entry.id === (reference.sourceExperienceId || ""));
    return Boolean(source && (reference.sourceBulletIndexes || []).length &&
      (reference.sourceBulletIndexes || []).every((index) => index >= 0 && index < source.bullets.length));
  }
  if (kind === "language") {
    return profile.languages.some((entry) =>
      normalized(entry.language) === normalized(reference.language || "") &&
      (!reference.level || normalized(entry.level) === normalized(reference.level))
    );
  }
  if (kind === "skill") return skillSupported(reference.skill || "", profile);
  if (kind === "certification") {
    return profile.certifications.some((entry) => normalized(entry) === normalized(reference.certification || ""));
  }
  if (kind === "education") return profile.education.some((entry) => entry.id === (reference.educationId || ""));
  if (kind === "employment") {
    return profile.experiences.some((entry) => entry.id === (reference.sourceExperienceId || ""));
  }
  if (kind === "project") return (profile.projects || []).some((entry) => entry.id === (reference.projectId || ""));
  if (kind === "authorization") return Boolean(authorizationText(profile));
  if (kind === "inference") {
    return (reference.confidence || "high") === "high" &&
      Boolean((reference.value || "").trim() && (reference.basis || "").trim());
  }
  return false;
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
    ...cv.experiences.flatMap((experience) => [experience.role, experience.company, ...experience.bullets.map(bulletText)]),
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
    return !source || experience.bullets.some((bullet) =>
      !bullet.sourceBulletIndexes.length ||
      bullet.sourceBulletIndexes.some((index) => index < 0 || index >= source.bullets.length) ||
      bullet.evidenceStatus !== "verified"
    );
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

  const skillEvidenceByName = new Map(cv.skillEvidence.map((skill) => [normalized(skill.skill), skill]));
  const unsupportedSkills = cv.skills.filter((skill) => {
    const evidence = skillEvidenceByName.get(normalized(skill));
    return evidence?.provenance !== "inferred-baseline" && !skillSupported(skill, profile);
  });
  checks.push(check(
    "skill-evidence",
    "truthfulness",
    unsupportedSkills.length ? "warn" : "pass",
    "Skills are evidenced by the base profile",
    unsupportedSkills.length ? `Review unsupported or heavily reframed skills: ${unsupportedSkills.join(", ")}.` : "Every output skill has detectable source evidence.",
    2
  ));

  const staleSummaryClaims = cv.summaryClaims.filter((claim) =>
    !["verified", "needs-review"].includes(claim.evidenceStatus) ||
    !claim.evidence.length ||
    claim.evidence.some((reference) => !summaryEvidenceValid(reference, profile))
  );
  const missingSummaryEvidence = Boolean(cv.summary.trim()) && cv.summaryClaims.length === 0;
  checks.push(check(
    "summary-evidence",
    "truthfulness",
    staleSummaryClaims.length || missingSummaryEvidence ? "fail" : "pass",
    "Summary claims retain verified evidence",
    missingSummaryEvidence
      ? "The summary has no claim-level evidence."
      : staleSummaryClaims.length
        ? `${staleSummaryClaims.length} summary claim(s) are stale or unsupported.`
        : "Summary claims are linked to verified source evidence.",
    3
  ));

  const claimsMissingFromSummary = cv.summaryClaims.filter((claim) =>
    !normalized(cv.summary).includes(normalized(claim.text))
  );
  checks.push(check(
    "summary-claim-text",
    "truthfulness",
    claimsMissingFromSummary.length ? "fail" : "pass",
    "Summary claims appear in the actual prose",
    claimsMissingFromSummary.length
      ? `Claim text missing from the summary: ${claimsMissingFromSummary.map((claim) => claim.id).join(", ")}.`
      : "Every structured summary claim is represented in the summary text.",
    3
  ));

  const mandatorySummaryClaims = cv.evidencePlan?.summaryClaims.filter((claim) => claim.mandatory) || [];
  const omittedMandatorySummaryClaims = mandatorySummaryClaims.filter((claim) =>
    !cv.summaryClaims.some((output) => output.id === claim.id)
  );
  checks.push(check(
    "summary-decisive-evidence",
    "relevance",
    omittedMandatorySummaryClaims.length ? "fail" : "pass",
    "Decisive matched requirements appear in the summary",
    omittedMandatorySummaryClaims.length
      ? `Mandatory summary claims omitted: ${omittedMandatorySummaryClaims.map((claim) => claim.id).join(", ")}.`
      : "All decisive matched requirements planned for the summary are present.",
    3
  ));

  const inferredSummaryClaims = cv.summaryClaims.filter((claim) =>
    claim.provenance === "inferred-context" ||
    claim.evidenceStatus === "needs-review" ||
    claim.evidence.some((reference) => reference.kind === "inference")
  );
  checks.push(check(
    "summary-inference-review",
    "truthfulness",
    inferredSummaryClaims.length ? "warn" : "pass",
    "Inferred summary context is identified",
    inferredSummaryClaims.length
      ? `Review inferred summary context before applying: ${inferredSummaryClaims.map((claim) => claim.text).join("; ")}.`
      : "The summary contains no inferred context.",
    1
  ));

  const reusedBaseSummary = normalized(cv.summary) === normalized(profile.summary);
  const blueprint = cv.evidencePlan?.summaryBlueprint;
  const shouldDiffer = Boolean(blueprint &&
    ((blueprint.decisiveRequirementIds || []).length ||
      ["transition", "adjacent-identity", "education-led", "executive"].includes(blueprint.positioningMode || "")) &&
    !normalized(profile.summary).includes(normalized(job.title)));
  checks.push(check(
    "summary-tailoring-specificity",
    "relevance",
    reusedBaseSummary && shouldDiffer ? "fail" : "pass",
    "Summary reflects the target role when useful",
    reusedBaseSummary && shouldDiffer
      ? "The base summary was reused despite a job-specific positioning blueprint."
      : reusedBaseSummary
        ? "The existing summary already satisfies the target blueprint."
        : "The summary is materially tailored to the target blueprint.",
    3
  ));

  const staleSkillEvidence = cv.skills.filter((skill) => {
    const evidence = skillEvidenceByName.get(normalized(skill));
    return !evidence || !["verified", "needs-review"].includes(evidence.evidenceStatus) ||
      evidence.evidence.some((reference) => {
        const source = sourceById.get(reference.sourceExperienceId);
        return !source || reference.sourceBulletIndexes.some((index) => index < 0 || index >= source.bullets.length);
      });
  });
  checks.push(check(
    "skill-provenance",
    "truthfulness",
    staleSkillEvidence.length ? "fail" : "pass",
    "Skill evidence is current",
    staleSkillEvidence.length ? `Stale, missing, or unsupported skill evidence: ${staleSkillEvidence.join(", ")}.` : "Skill evidence is current.",
    2
  ));

  const inferredSkills = cv.skillEvidence.filter((skill) =>
    skill.provenance === "inferred-baseline" || skill.evidenceStatus === "needs-review"
  );
  checks.push(check(
    "inferred-skill-review",
    "truthfulness",
    inferredSkills.length ? "warn" : "pass",
    "Inferred baseline skills are identified",
    inferredSkills.length
      ? `Review inferred baseline skills before applying: ${inferredSkills.map((skill) => skill.skill).join(", ")}.`
      : "No inferred baseline skills were added.",
    1
  ));

  const unsupportedCertifications = cv.certifications.filter((certification) =>
    !profile.certifications.some((source) => normalized(source) === normalized(certification))
  );
  checks.push(check(
    "certification-evidence",
    "truthfulness",
    unsupportedCertifications.length ? "fail" : "pass",
    "Certifications come from the base profile",
    unsupportedCertifications.length ? `Unsupported certifications: ${unsupportedCertifications.join(", ")}.` : "All certifications are source-backed.",
    3
  ));

  const plannedRequirements = cv.evidencePlan?.requirements.filter((requirement) =>
    ["must", "important"].includes(requirement.priority) &&
    ["explicit", "supported-equivalent", "inferred-baseline"].includes(requirement.coverage)
  ) || [];
  const omittedRequirements = plannedRequirements.filter((requirement) => {
    const mappedSkills = [
      ...requirement.sourceSkills,
      ...cv.skillEvidence.filter((skill) => skill.requirementIds.includes(requirement.id)).map((skill) => skill.skill)
    ];
    const appearsAsSkill = mappedSkills.some((skill) => cv.skills.some((outputSkill) =>
      normalized(outputSkill) === normalized(skill)
    ));
    const appearsInText = requirement.evidence.some((reference) => {
      const role = cv.experiences.find((experience) => experience.sourceExperienceId === reference.sourceExperienceId);
      return role?.bullets.some((bullet) =>
        bullet.sourceBulletIndexes.some((index) => reference.sourceBulletIndexes.includes(index))
      );
    });
    return !appearsAsSkill && !appearsInText && !normalized(cv.summary).includes(normalized(requirement.text));
  });
  checks.push(check(
    "requirement-coverage",
    "relevance",
    omittedRequirements.length ? "warn" : "pass",
    "Supported priority requirements are represented",
    omittedRequirements.length
      ? `Supported requirements omitted from the resume: ${omittedRequirements.map((requirement) => requirement.text).join("; ")}.`
      : "All supported must-have and important requirements are represented.",
    3
  ));

  const sourceSkillCount = new Set([
    ...profile.skills,
    ...Object.values(profile.skillCategories).flat()
  ].map(normalized)).size;
  const excessivePruning = sourceSkillCount >= 8 && cv.skills.length < 8;
  checks.push(check(
    "skill-retention-floor",
    "relevance",
    excessivePruning ? "warn" : "pass",
    "The skills section preserves meaningful source coverage",
    excessivePruning
      ? `Only ${cv.skills.length} of ${sourceSkillCount} source skills remain; retain at least eight when relevant evidence exists.`
      : `${cv.skills.length} skills are retained from the available source evidence and approved baseline keywords.`,
    2
  ));

  const sourceBulletCount = profile.experiences.reduce((sum, experience) => sum + experience.bullets.length, 0);
  const outputBulletCount = cv.experiences.reduce((sum, experience) => sum + experience.bullets.length, 0);
  const underfilledOnePage = cv.evidencePlan?.pageTarget === "one" &&
    ((sourceBulletCount >= 4 && outputBulletCount < 4) || (sourceSkillCount >= 8 && cv.skills.length < 8));
  checks.push(check(
    "underfilled-resume",
    "relevance",
    underfilledOnePage ? "warn" : "pass",
    "Available page space is used for relevant evidence",
    underfilledOnePage
      ? "The one-page resume is underfilled while additional source-backed bullets or skills are available."
      : "The resume uses its planned page budget without obvious evidence underfill.",
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
    experience.bullets.filter((bullet) => words(bulletText(bullet)).length > 32).map((bullet) => `${experience.role}: ${words(bulletText(bullet)).length} words`)
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
    experience.bullets.filter((bullet) => sentenceCount(bulletText(bullet)) > 1).map(() => experience.role)
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
    !experience.role.trim() || !experience.company.trim() || !experience.bullets.some((bullet) => bulletText(bullet).trim())
  );
  const missingExperience = cv.experiences.length === 0;
  checks.push(check(
    "ats-role-structure",
    "ats",
    incompleteRoles.length || missingExperience ? "fail" : "pass",
    "Experience entries have parsable structure",
    missingExperience
      ? "The tailored resume has no source-backed experience entries."
      : incompleteRoles.length
        ? `${incompleteRoles.length} role(s) are missing a title, company, or bullet.`
        : "Every role has a title, company, and at least one bullet.",
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

  const unverifiedTitles = cv.experiences.filter((experience) => experience.titleEvidenceStatus === "needs-review");
  checks.push(check(
    "title-evidence",
    "appropriateness",
    unverifiedTitles.length ? "fail" : "pass",
    "Reframed titles have verified evidence",
    unverifiedTitles.length ? `${unverifiedTitles.length} title change(s) need evidence review.` : "All title decisions are verified.",
    3
  ));

  const targetTitle = normalized(job.title);
  const summaryStartsAsTitle = Boolean(targetTitle) && normalized(cv.summary).startsWith(targetTitle);
  const targetIdentityAllowed = cv.evidencePlan?.summaryBlueprint?.targetIdentityAllowed ?? false;
  checks.push(check(
    "target-title-claim",
    "appropriateness",
    summaryStartsAsTitle && !targetIdentityAllowed ? "fail" : "pass",
    "Target title is framed as intent, not implied employment history",
    summaryStartsAsTitle && !targetIdentityAllowed
      ? "The summary opens with the exact target title even though the evidence blueprint does not allow that identity."
      : summaryStartsAsTitle
        ? "The target identity is supported by the fit and evidence blueprint."
        : "The summary uses transition-safe positioning.",
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
