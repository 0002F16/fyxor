import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import pdfParse from "pdf-parse";
import { syntheticCases } from "./syntheticCases.mjs";

dotenv.config({ path: resolve("apps/api/.env") });

const execFileAsync = promisify(execFile);
const outputDir = resolve(process.env.BENCHMARK_OUTPUT_DIR || "output/pdf/resume-tailoring-eval/synthetic");
const provider = (process.env.BENCHMARK_PROVIDER || "deepseek-api") as "deepseek-api" | "groq-api" | "gemini-api" | "openai-api" | "codex-local";
const selectedIds = new Set((process.env.BENCHMARK_CASES || "").split(",").map((entry) => entry.trim()).filter(Boolean));
const cases = selectedIds.size ? syntheticCases.filter((entry) => selectedIds.has(entry.id)) : syntheticCases;
const append = process.env.BENCHMARK_APPEND === "1";

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function includes(summary: string, term: string): boolean {
  return summary.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

async function main() {
  const [{ createGenerator, providerStatus }, { generateUnifiedCv }, { makePdfWithAudit }, { evaluateTailoredCv }] =
    await Promise.all([
      import("../../apps/api/src/providers.js"),
      import("../../apps/api/src/unifiedPipeline.js"),
      import("../../apps/api/src/export.js"),
      import("../../apps/api/src/resumeEval.js")
    ]);

  if (!append) await rm(outputDir, { recursive: true, force: true });
  await mkdir(join(outputDir, "previews"), { recursive: true });
  const generator = createGenerator(provider);
  const model = providerStatus(provider).model;
  let results: Array<Record<string, unknown>> = [];
  const existingById = new Map<string, Record<string, unknown>>();
  if (append) {
    try {
      const existing = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
      if (Array.isArray(existing.results)) {
        for (const result of existing.results as Array<Record<string, unknown>>) {
          existingById.set(String(result.id), result);
        }
      }
      results = Array.from(existingById.values()).filter((result) => !selectedIds.has(String(result.id)));
    } catch {
      results = [];
    }
  }

  for (const [index, fixture] of cases.entries()) {
    const startedAt = Date.now();
    console.log(`[${index + 1}/${cases.length}] ${fixture.id} — ${fixture.job.title}`);
    try {
      const cv = await generateUnifiedCv({
        generator,
        profile: fixture.profile,
        job: fixture.job,
        runId: `benchmark-${fixture.id}`,
        provider,
        model
      });
      const evaluation = evaluateTailoredCv(fixture.profile, fixture.job, cv);
      const { buffer, audit } = await makePdfWithAudit(cv);
      const parsed = await pdfParse(buffer);
      const stem = `${fixture.id}-${safe(fixture.job.company)}-${safe(fixture.job.title)}`;
      const pdfName = `${stem}.pdf`;
      const jsonName = `${stem}.json`;
      const previewName = `${stem}.png`;
      await writeFile(join(outputDir, pdfName), buffer);
      await writeFile(join(outputDir, jsonName), JSON.stringify(cv, null, 2));
      try {
        await execFileAsync(process.env.PDFTOPPM || "pdftoppm", [
          "-png", "-r", "150", "-singlefile", join(outputDir, pdfName), join(outputDir, "previews", stem)
        ]);
      } catch (error) {
        console.warn(`Preview rendering skipped for ${fixture.id}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const summary = cv.summary;
      const assertions: Array<{ id: string; pass: boolean; detail: string }> = [];
      for (const term of fixture.expectation.requiredSummaryTerms) {
        assertions.push({ id: `required-${safe(term)}`, pass: includes(summary, term), detail: `Summary includes "${term}"` });
      }
      for (const [groupIndex, group] of (fixture.expectation.requiredAnyGroups || []).entries()) {
        assertions.push({
          id: `required-group-${groupIndex + 1}`,
          pass: group.some((term) => includes(summary, term)),
          detail: `Summary includes one of: ${group.join(", ")}`
        });
      }
      for (const claim of fixture.expectation.forbiddenClaims) {
        assertions.push({ id: `forbidden-${safe(claim)}`, pass: !includes(summary, claim), detail: `Summary excludes "${claim}"` });
      }
      assertions.push({
        id: "positioning-mode",
        pass: cv.evidencePlan?.summaryBlueprint?.positioningMode === fixture.expectation.positioningMode,
        detail: `Positioning mode is ${fixture.expectation.positioningMode}`
      });
      assertions.push({
        id: "summary-length",
        pass: summary.split(/\s+/).filter(Boolean).length >= 35 && summary.split(/\s+/).filter(Boolean).length <= 100,
        detail: "Summary contains 35-100 words"
      });
      assertions.push({
        id: "claim-text-present",
        pass: cv.summaryClaims.every((claim) => summary.toLocaleLowerCase().includes(claim.text.toLocaleLowerCase())),
        detail: "Every structured summary claim appears in the prose"
      });
      assertions.push({
        id: "page-target",
        pass: cv.evidencePlan?.pageTarget === fixture.expectation.pageTarget && parsed.numpages <= (fixture.expectation.pageTarget === "one" ? 1 : 2),
        detail: `Resume respects the ${fixture.expectation.pageTarget}-page target`
      });
      const inferredClaims = cv.summaryClaims.filter((claim) => claim.provenance === "inferred-context" || claim.evidenceStatus === "needs-review");
      assertions.push({
        id: "inference-provenance",
        pass: fixture.expectation.inferencePolicy === "allow-with-warning"
          ? inferredClaims.every((claim) => claim.evidenceStatus === "needs-review")
          : inferredClaims.length === 0,
        detail: fixture.expectation.inferencePolicy === "allow-with-warning"
          ? "Any inferred context is marked needs-review"
          : "Summary contains no inferred context"
      });

      const failedAssertions = assertions.filter((assertion) => !assertion.pass);
      const status = evaluation.hardFailures.length || failedAssertions.length
        ? "fail"
        : evaluation.checks.some((check) => check.status === "warn") ? "warn" : "pass";
      results.push({
        id: fixture.id,
        label: fixture.label,
        source: "synthetic",
        status,
        fit: fixture.expectation.fit,
        seniority: fixture.expectation.seniority,
        jobFamily: fixture.expectation.jobFamily,
        company: fixture.job.company,
        title: fixture.job.title,
        job: fixture.job,
        profileName: fixture.profile.contact.name,
        summary,
        scores: evaluation.scores,
        hardFailures: evaluation.hardFailures,
        warnings: evaluation.checks.filter((check) => check.status === "warn"),
        assertions,
        pipeline: cv.pipeline,
        pageCount: parsed.numpages,
        layoutAudit: audit,
        pdf: `synthetic/${pdfName}`,
        json: `synthetic/${jsonName}`,
        preview: `synthetic/previews/${previewName}`,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const prior = existingById.get(fixture.id);
      results.push(prior ? {
        ...prior,
        rerunError: error instanceof Error ? error.message : String(error),
        rerunProvider: provider,
        rerunAt: new Date().toISOString()
      } : {
        id: fixture.id,
        label: fixture.label,
        source: "synthetic",
        status: "fail",
        fit: fixture.expectation.fit,
        seniority: fixture.expectation.seniority,
        jobFamily: fixture.expectation.jobFamily,
        company: fixture.job.company,
        title: fixture.job.title,
        job: fixture.job,
        profileName: fixture.profile.contact.name,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt
      });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    provider,
    model,
    caseCount: results.length,
    results: results.sort((left, right) =>
      syntheticCases.findIndex((entry) => entry.id === left.id) -
      syntheticCases.findIndex((entry) => entry.id === right.id)
    )
  };
  await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    output: join(outputDir, "manifest.json"),
    pass: results.filter((result) => result.status === "pass").length,
    warn: results.filter((result) => result.status === "warn").length,
    fail: results.filter((result) => result.status === "fail").length
  }, null, 2));
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
