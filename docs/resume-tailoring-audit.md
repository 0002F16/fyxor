# Resume tailoring flow audit

## Executive verdict

The product has a sound editing/export shell and good prompt-level intentions, but it does not yet have a reliable quality-control loop. The visible “Resume strength” score measures completeness, not tailoring quality. The recommended CCC path performs several generation and audit stages, but the extension discards the audit artifacts, loses source-level provenance, and validates a different PDF from the one the user ultimately downloads.

The highest-leverage work is therefore not another prompt rewrite. It is to make evidence provenance and final-artifact evaluation first-class, then compare engines on a fixed benchmark.

## Current flow

1. Parse a PDF/DOCX into raw text.
2. Use an LLM to create a structured base profile.
3. Capture a job description from LinkedIn or a manual selection.
4. Choose one of two tailoring paths:
   - built-in: one structured LLM generation plus a separate title-review call;
   - CCC: skills plan, initial resume, skills rewrite, bullet plan, bullet rewrite, rule audit, and CCC PDF layout audit.
5. Map the result into `TailoredCv`.
6. Let the user edit/regenerate sections.
7. Export through the extension’s own HTML/Puppeteer PDF or DOCX renderer.

## What is working

- Single-column exports, conventional headings, real text, and DOCX/PDF options are sensible parsing-safe defaults.
- The built-in prompt explicitly forbids invented facts and asks for source role/bullet linkage.
- Inline editing and section regeneration give the user a practical correction loop.
- CCC has useful concepts: page budgets, age-weighted bullet counts, skills curation, banned-phrase checks, and visual density auditing.
- The new title-review step is conservative in wording and preserves titles when the model call fails.

## Critical findings

### 1. CCC provenance is fabricated after the fact

`apps/api/src/cccEngine.ts` assigns each generated role to a source role using title/company/date matching and finally positional fallback. It always emits an empty `sourceBulletIndexes` array and always returns `unsupportedClaims: []`.

This means the UI can show no unsupported-claim warning even though CCC has not proven any rewritten bullet. The current source IDs are useful for navigation, but not sufficient as evidence lineage.

### 2. The audited PDF is not the delivered PDF

CCC renders `resume.pdf`, audits that file, and writes `layout_audit.json`. The extension only reads `resume.json`, deletes the temporary run directory, and later exports through `apps/api/src/export.ts`.

Consequences:

- CCC’s page-budget result does not guarantee the extension PDF or DOCX fits.
- CCC’s HTML lead-phrase emphasis is stripped before the extension render.
- CCC fields such as role context, projects, and work authorization are dropped.
- Audit failures and flagged unsupported skills never reach the user or API response.

The new round-trip test confirms that core text survives both final export formats. It also showed that `pdf-parse` does not return the PDF text in visual reading order, placing section labels before the header in the extracted string. That does not prove a specific ATS will fail, but it is enough to justify tracking reading order with more than one parser and preferring DOCX when a target application accepts it.

### 3. Unsupported skills are deliberately retained

CCC flags skills absent from the source profile but keeps them. Its prompt also permits baseline office tools even when they are not present in the source. Both behaviors conflict with the product promise of “never invented” and with the built-in prompt’s stricter rules.

### 4. The user-facing score is a completeness score

The current score rewards contact fields, summary character count, two bullets per role, five skills, multiple skill groups, and education. It does not evaluate:

- source grounding;
- job relevance;
- keyword evidence versus keyword stuffing;
- title inflation;
- bullet readability;
- duplicated or generic language;
- numeric claim support;
- final PDF/DOCX page fit or text extraction.

Because dismissed checks are removed from the denominator, a user can increase the percentage by dismissing advice. “100%” therefore means “no undismissed completeness nags,” not “strong resume.”

### 5. The CCC keyword audit is not decision-grade

The extractor uses generic n-grams and a domain-biased preferred-term list. The quality gate then expects at least 15 matches out of at most 18 extracted candidates. This encourages surface repetition and is brittle across job families and languages.

A better relevance metric starts with source-supported capabilities that appear in the JD, then measures whether the tailored resume retained and foregrounded them.

### 6. Exact target-title requirements can overstate career pivots

CCC requires the exact target title in summary sentence one. The extension also prints the target title directly under the candidate’s name. This is useful for search matching, but for adjacent-role candidates it can read as a claim of current professional identity.

Prefer explicit intent when evidence is adjacent, for example “Software developer targeting Backend Engineer roles” or “Finance operations specialist transitioning into…”.

### 7. Engine behavior is inconsistent and can silently degrade

New storage defaults to CCC, while the schema default is built-in. If CCC is requested but unavailable, the API silently falls back to the single-pass engine. The resulting resume may be materially different in quality and latency without a durable engine/version marker on the CV.

Store `engine`, `provider`, `model`, prompt version, and eval result with every generated CV.

## Recommended evaluation system

Use three layers. Do not collapse them into one magic score.

### Layer 1: deterministic hard gates

Run on every generation and regeneration:

- every output role has a valid source role;
- every rewritten bullet cites valid source bullets;
- employers and dates are unchanged;
- every numeric claim exists in source evidence;
- unsupported skills are blocked or explicitly surfaced;
- no markup remnants;
- name/email and structured experience fields are present;
- final exported PDF and DOCX can be parsed back into text;
- final page count respects the selected budget.

`apps/api/src/resumeEval.ts` now implements the data-level subset of these checks.

### Layer 2: model/human rubric

Blindly compare outputs without showing which engine produced them. Score 1–5:

- relevance: best supported evidence is foregrounded for this JD;
- credibility: claims sound defensible in an interview;
- specificity: bullets describe concrete work and outcomes;
- readability: summary and bullets are concise and natural;
- appropriateness: seniority, title framing, and tone fit the candidate;
- differentiation: output is meaningfully better than the base resume.

Require reviewers to identify the sentence or bullet that caused any score below 4.

### Layer 3: product outcomes

Track only with enough sample size and consent:

- export rate after generation;
- manual edit rate and edit distance;
- unsupported-claim correction rate;
- regenerate rate by section;
- application submission rate;
- recruiter screen/interview rate by engine/version.

The best near-term proxy is not an ATS score. It is low correction burden plus high blind-review preference while all truthfulness gates pass.

## Benchmark design

Start with 24–40 anonymized profile/JD pairs:

- junior, mid, senior;
- direct fit, adjacent fit, stretch fit;
- technical, operations, finance, people/HR, and commercial roles;
- strong source evidence and thin source evidence;
- English and Polish.

For each pair, save:

- frozen base profile and JD;
- expected must-use evidence;
- forbidden claims/tools/titles;
- acceptable title variants;
- expected page budget;
- built-in and CCC outputs with engine/model/prompt versions.

Run deterministic evals on every output, then send only gate-passing outputs to blind review.

## Priority order

1. Preserve real source bullet lineage through CCC; do not use positional matching as proof.
2. Return CCC audits and block/warn on unsupported claims instead of hard-coding an empty list.
3. Evaluate the extension’s final PDF and DOCX, not CCC’s intermediate PDF.
4. Replace “Resume strength” with separate Completeness, Evidence, Relevance, and Readability signals.
5. Add engine/model/prompt/eval metadata to each CV and stop silent quality fallback.
6. Build the frozen benchmark and compare built-in versus CCC before further prompt tuning.
7. Simplify CCC only after ablation tests show which of its extra LLM passes improve blind-review scores.
