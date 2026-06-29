# CV Tailor Extension — CLAUDE.md

## What this is

A Chrome extension + Node API monorepo for AI-powered CV/resume tailoring. Users paste a job description, the app tailors their base profile CV to the job, and displays the result in a Google Docs-style inline-editable canvas.

**Monorepo packages:**
- `packages/shared` — Zod schemas, storage logic, `CvDocument` React component (shared between extension and export)
- `apps/api` — Express server, LLM integration, DOCX/PDF export, auth, Postgres
- `apps/extension` — Chrome extension (Manifest V3), React UI via Vite

## Build order (critical)

Always build `shared` first. The other packages import from `@cv-tailor/shared`'s compiled dist — a stale dist silently strips new Zod fields and `migrateStorage` drops data without errors.

```bash
npm run build                     # builds shared → api → extension in correct order
npm run build -w @cv-tailor/shared  # rebuild shared only (after schema changes)
npm run dev                       # starts the API in watch mode
npm run dev:extension             # starts the extension in watch mode (separate terminal)
npm test                          # vitest run (all *.test.ts files)
npm run typecheck                 # typecheck all workspaces
```

## Local dev setup

1. Start Postgres: `docker compose up -d`
2. Run DB migrations: `npx @better-auth/cli migrate` (Better Auth tables) — app tables auto-create on first API start
3. Copy `.env.example` to `apps/api/.env`, fill in keys
4. `npm run dev` (API on port 8787)
5. `npm run dev:extension` (Vite builds to `apps/extension/dist/`)
6. Load `apps/extension/dist/` as an unpacked extension in Chrome

Default DB: `postgres://postgres:postgres@127.0.0.1:5432/fyxor` (matches docker-compose)

## AI / LLM providers

Configured via `apps/api/.env`:
- `AI_PROVIDER` — `gemini-api` (default) | `openai-api` | `codex-local`
- `GEMINI_API_KEY` / `GEMINI_MODEL` (default: `gemini-2.5-flash`)
- `OPENAI_API_KEY` / `OPENAI_MODEL` (default: `gpt-4o-mini`)

The extension can override per-request via the `x-ai-provider` header.

## Tailoring pipeline

The default is the unified evidence-first pipeline: evidence plan → constrained
writer → independent critic → targeted repair when required. Tailoring runs are
persisted in `tailoring_runs` and exposed through `/api/tailoring-runs`.
Unified v3 sanitizes recoverable plan/writer mistakes, copies certifications and
languages exactly from the base profile, expands under-selected source skills and
bullets deterministically, and uses source-backed fallbacks before allowing a
factual issue to block export.

CCC and the original single-pass tailor are legacy benchmark/rollback engines.
They are reachable only when `ENABLE_LEGACY_ENGINES=true`.

- `CCC_ENGINE_ROOT` — path to the CCC repo root
- `CCC_PYTHON` — path to the CCC venv python (defaults to `$CCC_ENGINE_ROOT/.venv/bin/python3`)
- `CCC_LLM_PROVIDER` — override the LLM inside CCC (defaults to Gemini)
- CCC auto-loads its own `.env` from `$CCC_ENGINE_ROOT/.env`
- Production tailoring never silently falls back to CCC or the old single-pass engine.

Check availability: `GET /health` returns `{ ccc: { available, engineRoot, python } }`

## API routes

All routes under `/api/*` require auth (Better Auth bearer token) except `/health`, `/api/profile/parse-file`, and `/api/cvs/export`.

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/health` | Status + provider/CCC availability |
| POST | `/api/profile/parse-file` | Parse uploaded PDF/DOCX → raw text |
| POST | `/api/profile/extract` | LLM: raw text → structured `BaseProfile` |
| POST | `/api/profile/categorize-skills` | LLM: skills list → categorized skills |
| POST | `/api/tailoring-runs` | Create/reuse a recoverable unified tailoring run |
| GET/DELETE | `/api/tailoring-runs/:id` | Poll or cancel a tailoring run |
| POST | `/api/cvs/tailor` | Compatibility wrapper; unified unless legacy flag is enabled |
| POST | `/api/cvs/regenerate` | Regenerate one section and return a section patch |
| GET | `/api/data/sync` | Pull user data from Postgres |
| PUT | `/api/data/sync` | Push user data to Postgres |
| GET | `/api/data/usage` | Monthly tailor count for the user |
| POST | `/api/cvs/export` | Render CV to DOCX or PDF |

## Storage (extension)

Chrome `localStorage` key: **`cvTailorState`**

Parsed via `storageStateSchema.safeParse()` in `packages/shared/src/index.ts`. If parse fails (including an invalid `auth` object — `authSessionSchema` requires both `userId` + `token`), it silently resets to `emptyStorageState()` and the user sees the Auth gate. This is the most common "why did my data disappear" cause.

`migrateStorage()` runs on every load to upgrade old stored shapes. Always call it before using state from storage.

## Editor (extension)

`apps/extension/src/CvDocument.tsx` is the shared inline-editable canvas (also used read-only in the Tracker). Key behaviors:
- Every text node is `contentEditable`, commits on `onBlur`
- Autosaves to storage on every commit
- Section reordering via ▲▼ arrows; order stored in `sectionOrder: string[]` on both `baseProfileSchema` and `tailoredCvSchema`
- `effectiveSectionOrder()` in shared resolves `sectionOrder` (empty = `DEFAULT_SECTION_ORDER`)
- Section headings show a hover **Regenerate** button
- A4 page guides (794px canvas + dashed "Page N" lines) show only while editing
- Pass `editable={false}` for the read-only render path (Tracker)

Export honors `sectionOrder` and uses DOCX `keepNext`/`keepLines` + a pdfkit page-fit guard to avoid splitting sections across pages.

## Skill categories

Two representations kept in sync:
- Record shape: `skillCategories: Record<string, string[]>` (used in storage and UI)
- Array shape: `{ name, skills }[]` (used in LLM structured output)

`foldSkillCategories()` in `apps/api/src/app.ts` converts LLM array → record + flat `skills[]`. Always run this after tailor / regenerate / extract — forgetting it causes `skillCategories` to be dropped.

## LinkedIn integration

- Content script runs on `https://*.linkedin.com/jobs/*`
- `background.ts` asks the content script (`CV_TAILOR_SCRAPE_JOB`) for the DOM-scraped job title before falling back to `jobFromSelection`
- Generic feed titles ("Jobs where you'd be a top applicant") are filtered out

## Tests

```bash
npm test                          # all tests
npx vitest run apps/api           # api tests only
npx vitest run packages/shared    # shared tests only
```

Integration tests (`db.integration.test.ts`) require a live Postgres connection. Unit tests use vitest with `environment: "node"`.

## VPS / Production

- **SSH**: `ssh root@76.13.177.250`
- **API base URL**: `https://api-76-13-177-250.sslip.io` (sslip.io auto-TLS on the IP — no custom domain yet)
- **DB**: Postgres running via docker-compose on the VPS, same credentials as local (`postgres/postgres`, db `fyxor`)

## Monetization (testing phase)

- `FREE_MONTHLY_TAILORS=0` — unlimited tailors while in testing. Do not add a paywall or upgrade flow.
- The 402 / "upgrade" code path exists in `apps/api/src/app.ts` but is inert at limit=0. Leave it wired up for when the cap is eventually turned on.

## Resume quality thresholds (`apps/extension/src/resumeChecks.ts`)

| Constant | Value | Notes |
|---|---|---|
| `MIN_SUMMARY_CHARS` | 80 | Minimum summary length to pass the check |
| `MIN_BULLETS_PER_ROLE` | 2 | Bullets per experience role |
| `MIN_SKILLS` | 5 | Total skill count |

Tailored CVs use separate Evidence, Relevance, Readability, ATS, and
Appropriateness signals. Hard factual failures and stale evidence block export.

## Common gotchas

- **Stale shared dist**: always rebuild `@cv-tailor/shared` after changing schemas before testing the API or extension
- **Auth reset**: any invalid field in the `auth` object inside stored state triggers a full reset to `emptyStorageState()` — the user sees the sign-in screen and all local-only data is gone
- **CCC not configured**: API won't 503 — it falls back to built-in. Check `/health` if tailoring seems weaker than expected
- **OpenAI quota**: OpenAI quota was exhausted during development; default is Gemini. Set `AI_PROVIDER=gemini-api` if getting quota errors
- **Export without auth**: `/api/cvs/export` is intentionally unauthenticated (used for preview renders)
