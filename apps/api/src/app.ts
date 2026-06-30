import express from "express";
import cors from "cors";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import {
  baseProfileSchema,
  flattenSkillCategories,
  regenerationRequestSchema,
  syncPayloadSchema,
  tailoredCvSchema
} from "@cv-tailor/shared";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auth } from "./auth.js";
import {
  adminUsageSummary,
  listUsers,
  monthlyUsage,
  pool,
  recordUsage,
  releaseUsage,
  reserveTailor,
  userDetail
} from "./db.js";
import type { Generator } from "./openai.js";
import { createGenerator, providerStatus, resolveProvider } from "./providers.js";
import { categorizeSkillsPrompt, extractionPrompt, regenerationPrompt, tailoringPrompt } from "./prompts.js";
import {
  categorizeRequestSchema,
  exportRequestSchema,
  extractRequestSchema,
  llmBaseProfileSchema,
  llmSkillsSchema,
  llmTailoredCvSchema,
  tailorRequestSchema
} from "./schemas.js";
import { makeDocx, makePdfWithAudit } from "./export.js";
import { cccStatus, isCccAvailable, runCccEngine } from "./cccEngine.js";
import { reviewExperienceTitles } from "./titleReview.js";
import { generateUnifiedCv, PIPELINE_VERSION, regenerateUnifiedSection } from "./unifiedPipeline.js";
import { cancelTailoringRun, createTailoringRun, getTailoringRun } from "./tailoringRuns.js";

const asyncRoute = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

type AuthedRequest = express.Request & { userId: string };

// Tailoring failures store the raw thrown error (often a Zod issues-array JSON
// blob) so the admin dashboard keeps technical detail. The extension must never
// see that — replace any technical-looking error with a friendly retry message
// when serializing tailoring runs to the extension. Admin endpoints are not run
// through this, so they keep the raw detail.
const GENERIC_TAILORING_ERROR =
  "We couldn't finish tailoring this CV. This usually works on a second try — please tailor again.";

function looksTechnical(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return true;
  return /invalid_type|ZodError|received \w+|\bpath\b.*\bmessage\b/.test(trimmed);
}

export function clientRun<T extends { status?: string; error?: string }>(run: T): T {
  if (!run?.error) return run;
  if (run.status === "cancelled") return run; // keep "Tailoring cancelled"
  if (!looksTechnical(run.error)) return run; // keep already-friendly text
  return { ...run, error: GENERIC_TAILORING_ERROR };
}

// Comma-separated allowlist of admin emails (lowercased). Read once at load.
// An account is an admin purely by being listed here — no DB role column.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function generatorOrThrow(req: express.Request, factory?: () => Generator): Generator {
  return factory ? factory() : createGenerator(resolveProvider(req.header("x-ai-provider") || process.env.AI_PROVIDER));
}

// The structured-output schemas express skillCategories as an array of
// { name, skills }; everywhere else uses the record-shaped skillCategories plus
// a flat skills union. Fold the LLM's array form into both, dropping empty
// groups and re-deriving the flat list so the two representations stay aligned.
function foldSkillCategories(raw: Array<{ name: string; skills: string[] }> | undefined, fallbackSkills: string[]) {
  const categories = (raw || []).filter((c) => c.name.trim() && c.skills.length);
  const pairs = categories.map((c) => [c.name, c.skills] as [string, string[]]);
  const skills = flattenSkillCategories(pairs);
  return {
    skillCategories: Object.fromEntries(pairs),
    skills: skills.length ? skills : fallbackSkills
  };
}

export function createApp(generatorFactory?: () => Generator) {
  const app = express();
  // An injected generator means a DI/test embedding: skip the DB-backed auth so
  // unit tests run without Postgres. Real runs (no factory) are always gated.
  const testMode = Boolean(generatorFactory);

  app.use(cors({
    // chrome-extension + local dev. The admin SPA is same-origin (served by
    // this API) so it doesn't need its own entry; the sslip.io prod URL is
    // covered by the same-origin policy automatically.
    origin: /^(chrome-extension:\/\/|http:\/\/127\.0\.0\.1|http:\/\/localhost)/,
    allowedHeaders: ["Content-Type", "Authorization", "x-ai-provider", "x-tailoring-engine"],
    // The extension reads the bearer token from this header after sign-in.
    exposedHeaders: ["set-auth-token"]
  }));

  // Better Auth must see the raw body, so mount it BEFORE express.json().
  app.all(/^\/api\/auth\//, toNodeHandler(auth));

  app.use(express.json({ limit: "15mb" }));

  // Lightweight request log: shows every request's method, path, status and
  // duration on finish — the signal we need to tell "request never arrived" from
  // "arrived and succeeded" when diagnosing slow/hung tailoring.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.log(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - started}ms)`);
    });
    next();
  });

  // Validates the bearer session and attaches req.userId, else 401.
  const requireAuth: express.RequestHandler = async (req, res, next) => {
    if (testMode) { (req as AuthedRequest).userId = "test-user"; return next(); }
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user) return res.status(401).json({ error: "Sign in required" });
      (req as AuthedRequest).userId = session.user.id;
      next();
    } catch (error) { next(error); }
  };

  // Gates the admin dashboard API: a valid session whose email is in the
  // ADMIN_EMAILS allowlist. Mirrors requireAuth's session resolution; returns
  // 403 (not 401) for a signed-in but non-admin user so the UI can distinguish.
  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (testMode) { (req as AuthedRequest).userId = "test-admin"; return next(); }
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user) return res.status(401).json({ error: "Sign in required" });
      if (!ADMIN_EMAILS.has((session.user.email || "").toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      (req as AuthedRequest).userId = session.user.id;
      next();
    } catch (error) { next(error); }
  };

  const meter = async (req: express.Request, action: string, meta?: unknown) => {
    if (!testMode) await recordUsage((req as AuthedRequest).userId, action, meta);
  };

  app.get("/health", (req, res) => {
    const status = providerStatus(resolveProvider(req.query.provider || req.header("x-ai-provider") || process.env.AI_PROVIDER));
    res.json({
      ok: true,
      ...status,
      configured: generatorFactory ? true : status.configured,
      pipeline: { version: PIPELINE_VERSION, legacyEnabled: process.env.ENABLE_LEGACY_ENGINES === "true" },
      ccc: cccStatus()
    });
  });

  app.post("/api/profile/parse-file", asyncRoute(async (req, res) => {
    const { base64, fileName = "" } = req.body as { base64?: string; fileName?: string };
    if (!base64) return res.status(400).json({ error: "Missing file data" });
    const buffer = Buffer.from(base64, "base64");
    const text = fileName.toLowerCase().endsWith(".pdf")
      ? (await pdfParse(buffer)).text
      : (await mammoth.extractRawText({ buffer })).value;
    res.json({ text });
  }));

  app.post("/api/profile/extract", requireAuth, asyncRoute(async (req, res) => {
    const input = extractRequestSchema.parse(req.body);
    const now = new Date().toISOString();
    const result = await generatorOrThrow(req, generatorFactory).generate({
      name: "base_profile",
      schema: llmBaseProfileSchema,
      instructions: extractionPrompt,
      payload: { ...input, id: crypto.randomUUID(), updatedAt: now }
    });
    await meter(req, "extract");
    res.json(baseProfileSchema.parse({
      ...result,
      ...foldSkillCategories(result.skillCategories, result.skills),
      rawText: input.text,
      updatedAt: now
    }));
  }));

  app.post("/api/profile/categorize-skills", requireAuth, asyncRoute(async (req, res) => {
    const input = categorizeRequestSchema.parse(req.body);
    const result = await generatorOrThrow(req, generatorFactory).generate({
      name: "skill_categories",
      schema: llmSkillsSchema,
      instructions: categorizeSkillsPrompt,
      payload: input
    });
    await meter(req, "categorize");
    res.json(foldSkillCategories(result.skillCategories, result.skills.length ? result.skills : input.skills));
  }));

  app.post("/api/cvs/tailor", requireAuth, asyncRoute(async (req, res) => {
    const input = tailorRequestSchema.parse(req.body);
    // Optional free-tier cap. Default 0 = unlimited, so monetization can switch
    // on later by setting FREE_MONTHLY_TAILORS without code changes.
    const limit = Number(process.env.FREE_MONTHLY_TAILORS || 0);
    // When capped, atomically reserve a slot up front (check+insert in one
    // locked transaction) so concurrent requests can't all slip past the cap.
    // The reservation is released below if tailoring throws, so failures don't
    // burn a slot. When uncapped we keep the cheaper "record after success" path.
    let reservedEventId: string | undefined;
    if (!testMode && limit > 0) {
      const reservation = await reserveTailor((req as AuthedRequest).userId, limit);
      if (!reservation.ok) {
        return res.status(402).json({ error: "Monthly free limit reached. Upgrade to continue tailoring." });
      }
      reservedEventId = reservation.eventId;
    }
    // A single guard so the slot is released at most once, whether tailoring
    // throws (catch below) or the client cancels and disconnects mid-flight
    // (the close handler) — so a cancelled run never burns a free-tier slot.
    let released = false;
    const releaseOnce = async () => {
      if (released || !reservedEventId) return;
      released = true;
      await releaseUsage(reservedEventId).catch(() => {});
    };
    // The popup's Cancel aborts the request, closing the connection before the
    // response finishes; release the reservation when that happens.
    if (reservedEventId) res.on("close", () => { if (!res.writableEnded) void releaseOnce(); });
    try {
      const engine = req.header("x-tailoring-engine") || (req.body as { tailoringEngine?: string }).tailoringEngine;
      const legacyEnabled = process.env.ENABLE_LEGACY_ENGINES === "true";
      // Legacy engines exist only for controlled benchmarking/rollback. Normal
      // production requests always take the unified evidence-first path.
      if (legacyEnabled && engine === "ccc" && isCccAvailable()) {
        const generated = tailoredCvSchema.parse(await runCccEngine(input.profile, input.job));
        const cv = await reviewExperienceTitles(
          () => generatorOrThrow(req, generatorFactory),
          input.profile,
          input.job,
          generated
        );
        if (!reservedEventId) await meter(req, "tailor", { pipelineVersion: "legacy-ccc", engine: "ccc" });
        return res.json(cv);
      }
      if (legacyEnabled && engine === "ccc") console.warn("CCC engine requested but not configured — falling back to the legacy built-in tailor.");
      const now = new Date().toISOString();
      const generator = generatorOrThrow(req, generatorFactory);
      if (!legacyEnabled || engine !== "builtin") {
        const cv = await generateUnifiedCv({
          generator,
          profile: input.profile,
          job: input.job,
          runId: crypto.randomUUID(),
          provider: resolveProvider(req.header("x-ai-provider") || process.env.AI_PROVIDER),
          model: providerStatus(resolveProvider(req.header("x-ai-provider") || process.env.AI_PROVIDER)).model
        });
        if (!reservedEventId) await meter(req, "tailor", {
          pipelineVersion: cv.pipeline.pipelineVersion,
          provider: cv.pipeline.provider,
          model: cv.pipeline.model,
          aiCallCount: cv.pipeline.aiCallCount,
          repairCount: cv.pipeline.repairCount,
          stages: cv.pipeline.stages
        });
        return res.json(cv);
      }
      const result = await generator.generate({
        name: "tailored_cv",
        schema: llmTailoredCvSchema,
        instructions: tailoringPrompt,
        payload: { ...input, cvId: crypto.randomUUID(), now }
      });
      const generated = tailoredCvSchema.parse({ ...result, ...foldSkillCategories(result.skillCategories, result.skills) });
      const cv = await reviewExperienceTitles(
        generator,
        input.profile,
        input.job,
        generated
      );
      if (!reservedEventId) await meter(req, "tailor", { pipelineVersion: "legacy-builtin", engine: "builtin" });
      res.json(cv);
    } catch (error) {
      // Tailoring failed — release the reserved slot so the user isn't charged.
      await releaseOnce();
      throw error;
    }
  }));

  app.post("/api/tailoring-runs", requireAuth, asyncRoute(async (req, res) => {
    const input = tailorRequestSchema.parse(req.body);
    const provider = resolveProvider(req.header("x-ai-provider") || process.env.AI_PROVIDER);
    const run = await createTailoringRun({
      userId: (req as AuthedRequest).userId,
      provider,
      profile: input.profile,
      job: input.job,
      testMode,
      generatorFactory,
      freeMonthlyLimit: Number(process.env.FREE_MONTHLY_TAILORS || 0)
    });
    res.status(202).json(clientRun(run));
  }));

  app.get("/api/tailoring-runs/:id", requireAuth, asyncRoute(async (req, res) => {
    const run = await getTailoringRun(String(req.params.id), (req as AuthedRequest).userId, testMode);
    if (!run) return res.status(404).json({ error: "Tailoring run not found" });
    res.json(clientRun(run));
  }));

  app.delete("/api/tailoring-runs/:id", requireAuth, asyncRoute(async (req, res) => {
    const run = await cancelTailoringRun(String(req.params.id), (req as AuthedRequest).userId, testMode);
    if (!run) return res.status(404).json({ error: "Tailoring run not found" });
    res.json(clientRun(run));
  }));

  app.post("/api/cvs/regenerate", requireAuth, asyncRoute(async (req, res) => {
    const input = regenerationRequestSchema.parse(req.body);
    const generator = generatorOrThrow(req, generatorFactory);
    if (input.cv.evidencePlan && input.cv.pipeline.pipelineVersion.startsWith("unified")) {
      const patch = await regenerateUnifiedSection({
        generator,
        profile: input.profile,
        cv: input.cv,
        section: input.section,
        experienceId: input.experienceId
      });
      await meter(req, "regenerate");
      return res.json(patch);
    }
    const result = await generator.generate({
      name: "regenerated_cv",
      schema: llmTailoredCvSchema,
      instructions: regenerationPrompt,
      payload: input
    });
    const generated = tailoredCvSchema.parse({
      ...result,
      ...foldSkillCategories(result.skillCategories, result.skills),
      updatedAt: new Date().toISOString()
    });
    const requestedSourceExperienceId = input.section === "experience"
      ? input.cv.experiences.find((experience) => experience.id === input.experienceId)?.sourceExperienceId
      : undefined;
    const sourceExperienceIds = requestedSourceExperienceId
      ? new Set([requestedSourceExperienceId])
      : new Set<string>();
    const cv = input.section === "experience"
      ? await reviewExperienceTitles(
        generator,
        input.profile,
        input.cv.job,
        generated,
        sourceExperienceIds
      )
      : generated;
    await meter(req, "regenerate");
    res.json(cv);
  }));

  app.get("/api/data/sync", requireAuth, asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT profile, drafts, applications FROM user_data WHERE user_id = $1",
      [(req as AuthedRequest).userId]
    );
    const row = rows[0];
    res.json(syncPayloadSchema.parse(row ?? {}));
  }));

  app.put("/api/data/sync", requireAuth, asyncRoute(async (req, res) => {
    const payload = syncPayloadSchema.parse(req.body);
    await pool.query(
      `INSERT INTO user_data (user_id, profile, drafts, applications, updated_at)
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE
         SET profile = EXCLUDED.profile,
             drafts = EXCLUDED.drafts,
             applications = EXCLUDED.applications,
             updated_at = now()`,
      [
        (req as AuthedRequest).userId,
        payload.profile == null ? null : JSON.stringify(payload.profile),
        JSON.stringify(payload.drafts),
        JSON.stringify(payload.applications)
      ]
    );
    res.json({ ok: true });
  }));

  app.get("/api/data/usage", requireAuth, asyncRoute(async (req, res) => {
    res.json(await monthlyUsage((req as AuthedRequest).userId));
  }));

  app.post("/api/cvs/export", requireAuth, asyncRoute(async (req, res) => {
    const { profile, cv } = exportRequestSchema.parse(req.body);
    const format = req.query.format === "pdf" ? "pdf" : "docx";
    const pdfResult = format === "pdf" ? await makePdfWithAudit(cv) : undefined;
    const buffer = pdfResult ? pdfResult.buffer : await makeDocx(cv);
    const extracted = format === "pdf"
      ? await pdfParse(buffer)
      : await mammoth.extractRawText({ buffer });
    const text = ("text" in extracted ? extracted.text : extracted.value).toLocaleLowerCase().replace(/\s+/g, " ");
    const expected = [
      cv.contact.name,
      cv.contact.email,
      ...cv.experiences.flatMap((experience) => [
        experience.role,
        experience.company,
        ...experience.bullets.map((bullet) => bullet.text)
      ])
    ].map((value) => value.trim()).filter(Boolean);
    const missing = expected.filter((value) => !text.includes(value.toLocaleLowerCase().replace(/\s+/g, " ")));
    const pageTarget = cv.evidencePlan?.pageTarget === "one" ? 1 : 2;
    const pageCount = format === "pdf" && "numpages" in extracted ? Number(extracted.numpages) : undefined;
    const layoutBlocked = Boolean(pdfResult?.audit.horizontalOverflow || pdfResult?.audit.clippedElementCount);
    if (missing.length || (pageCount != null && pageCount > pageTarget) || layoutBlocked) {
      return res.status(409).json({
        error: "Export validation failed for the generated file.",
        findings: [
          ...(missing.length ? [{ id: "artifact-missing-content", detail: `Missing extracted content: ${missing.slice(0, 5).join("; ")}` }] : []),
          ...(pageCount != null && pageCount > pageTarget ? [{ id: "artifact-page-overflow", detail: `Generated ${pageCount} pages; target is ${pageTarget}.` }] : []),
          ...(layoutBlocked ? [{ id: "artifact-clipping", detail: "The final PDF contains horizontally clipped or overflowing content." }] : [])
        ]
      });
    }
    if (pdfResult && pageCount && pdfResult.audit.characterCount / pageCount > 5000) {
      res.setHeader("X-Fyxor-Warnings", "The resume is visually dense; consider trimming content.");
    }
    res.type(format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const safeSegment = (s: string) => s.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "cv";
    res.setHeader("Content-Disposition", `attachment; filename="${safeSegment(cv.job.company || "tailored")}-${safeSegment(cv.job.title || "cv")}.${format}"`);
    res.send(buffer);
  }));

  // --- Admin dashboard API (read-only, allowlist-gated) ---------------------

  app.get("/api/admin/summary", requireAdmin, asyncRoute(async (_req, res) => {
    res.json(await adminUsageSummary());
  }));

  app.get("/api/admin/users", requireAdmin, asyncRoute(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const offset = req.query.offset != null ? Number(req.query.offset) : undefined;
    res.json({ users: await listUsers({ search, limit, offset }) });
  }));

  app.get("/api/admin/users/:id", requireAdmin, asyncRoute(async (req, res) => {
    const detail = await userDetail(String(req.params.id));
    if (!detail.user) return res.status(404).json({ error: "User not found" });
    res.json(detail);
  }));

  // --- Admin SPA static hosting (served under /admin) ------------------------
  // Resolve relative to this source file (apps/api/src/app.ts → apps/admin/dist)
  // so the path is correct regardless of what cwd PM2 or npm uses. Override
  // with ADMIN_DIST env var when needed.
  // dist layout: apps/api/dist/apps/api/src/app.js → 6 levels up = repo root
  const adminDist =
    process.env.ADMIN_DIST ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../apps/admin/dist");
  if (fs.existsSync(adminDist)) {
    app.use("/admin", express.static(adminDist));
    // SPA fallback: any /admin/* path that didn't match a static asset returns
    // index.html. Express 5 path syntax rejects a bare "*", so match via regex.
    app.get(/^\/admin(?:\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(adminDist, "index.html"));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(error);
    const status = message.includes("Monthly free limit reached")
      ? 402
      : message.includes("not configured") || message.includes("Local Codex failed")
        ? 503
        : 400;
    res.status(status).json({ error: message });
  });
  return app;
}
