# Resume Tailoring Benchmark

This directory is the frozen, anonymized comparison set for the unified pipeline,
legacy built-in tailoring, and CCC. Do not add real contact details or unredacted
job descriptions.

Each case records:

- a base profile and job description;
- fit type, seniority, language, and job family;
- evidence that strong output should use;
- claims, tools, titles, and metrics output must not invent;
- acceptable title variants and page target.

Run deterministic truthfulness checks before blind human review. Human reviewers
score relevance, credibility, specificity, readability, appropriateness, and
differentiation from 1–5 without seeing the engine name.

Release thresholds are documented in `docs/resume-tailoring-audit.md`. Production
legacy-engine retirement remains controlled by `ENABLE_LEGACY_ENGINES`.

## Synthetic adaptive-summary suite

`syntheticCases.mts` contains 12 complete fictional profile/job pairs spanning
direct fits, adjacent specializations, career changes, language and certification
requirements, education-led applicants, executives, thin profiles, work
authorization, and already-optimal summaries.

Run the real unified pipeline, deterministic assertions, PDF export, preview
rendering, and manifest generation with:

```bash
npm run benchmark:resume
```

The benchmark defaults to DeepSeek. Old provider names are accepted only as
compatibility inputs and are normalized to DeepSeek by the API provider layer.
Use `BENCHMARK_CASES=synthetic-turkish-language-04,synthetic-authorization-11` to run
a focused subset.
