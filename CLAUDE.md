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
- `AI_PROVIDER` — `deepseek-api` (runtime is hard-locked; old names normalize to DeepSeek)
- `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` (default: `deepseek-v4-flash`)

The extension may still send `x-ai-provider`, but the API normalizes every value
to DeepSeek.

**Tailoring quality is gated by the model, not just the prompts.** A tailoring
run makes 5 sequential LLM calls (~27K tokens total, largest single call —the
critic— ~8.5K tokens). `apps/api/src/prompts.ts` already encodes fairly strict
constraints (JD-verbatim keywords, exact summary length, no invented facts,
no generic soft-skill filler); a small/weak model will silently ignore them. If
a tailored CV reads generic or off-target, check `DEEPSEEK_MODEL` and the
DeepSeek dashboard before assuming the prompt is wrong.

## Tailoring pipeline

The default is the unified evidence-first pipeline (v4): evidence plan → three
focused writer calls (summary, experience/bullets, skills) → independent critic →
targeted repair when required. Tailoring runs are persisted in `tailoring_runs`
and exposed through `/api/tailoring-runs`.

The writer is split into three sequential LLM calls so a failure in one section
cannot poison the others:
- `resume_summary` (`summaryWriterPrompt`): reads the full job title + scraped
  description + classified requirements; mirrors the JD's exact terminology.
- `resume_experience` (`experienceWriterPrompt`): rewrites bullets constrained to
  plan-approved source evidence.
- `resume_skills` (`skillsWriterPrompt`): groups the plan-approved skills into
  themed categories; may not add, drop, or rename any skill.

Certifications are copied verbatim from the base profile (no LLM call). Skill
selection happens in the planner; the skills writer only regroups them.
Unified v4 sanitizes recoverable plan/writer mistakes, expands under-selected
source skills and bullets deterministically, and uses source-backed fallbacks
before allowing a factual issue to block export.

CCC and the original single-pass tailor are legacy benchmark/rollback engines.
They are reachable only when `ENABLE_LEGACY_ENGINES=true`.

- `CCC_ENGINE_ROOT` — path to the CCC repo root
- `CCC_PYTHON` — path to the CCC venv python (defaults to `$CCC_ENGINE_ROOT/.venv/bin/python3`)
- Legacy CCC runs are passed DeepSeek via its OpenAI-compatible mode.
- CCC auto-loads its own `.env` from `$CCC_ENGINE_ROOT/.env`
- Production tailoring never silently falls back to CCC or the old single-pass engine.

Check availability: `GET /health` returns `{ ccc: { available, engineRoot, python } }`

## Concurrent tailoring runs

Users can have several tailors in flight at once (extension shows up to 3
running + more queued). This is enforced server-side, not client-side: an
in-process scheduler in `apps/api/src/tailoringRuns.ts` holds newly created
runs at `status="queued"` until both caps have room, then starts them via the
existing `executeRun`.

- `PER_USER_MAX_CONCURRENT_TAILORS` (default 3) — cap per user.
- `GLOBAL_MAX_CONCURRENT_TAILORS` (default 6) — cap across all users on this
  VPS process; the primary guard against overloading DeepSeek/CPU. Tune it
  against `GET /health`'s `load` block (queued/running counts, memory, DB pool)
  and DeepSeek's own rate limits.
- The scheduler drains FIFO as running runs finish; it survives a server
  restart via the existing `recoverTailoringRuns()` recovery path.
- `tailoring_runs` also has `started_at`/`finished_at` columns (queued→running
  and →terminal transitions) so wait time and actual duration can be computed
  separately from `created_at`/`updated_at`.

## API routes

All routes under `/api/*` require auth (Better Auth bearer token) except `/health`, `/api/profile/parse-file`, and `/api/cvs/export`.

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/health` | Status + provider/CCC availability + load (memory, DB pool, queue depth) |
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
| GET | `/api/admin/summary` | Admin-only: platform usage rollup |
| GET | `/api/admin/users` | Admin-only: account list + per-user tailor counts |
| GET | `/api/admin/users/:id` | Admin-only: one user's usage + recent runs |
| GET | `/api/admin/queue-status` | Admin-only: live queued/running counts, global scheduler state |

## Admin dashboard

A read-only web dashboard (`apps/admin`, React + Vite) for listing accounts and
monitoring usage. Served as static files by the API under **`/admin`**
(`express.static`, so `https://fyxor.eu/admin` in prod). Access is gated by
`requireAdmin` in `apps/api/src/app.ts`: a valid Better Auth session whose email is
in the **`ADMIN_EMAILS`** allowlist (comma-separated env var). No role column or DB
migration — admin status is purely the allowlist. Non-admins get `403`.

Admin DB queries (`listUsers`, `adminUsageSummary`, `userDetail`) live in
`apps/api/src/db.ts` and join Better Auth's `"user"` table with `usage_events` /
`tailoring_runs`. Run-detail responses omit the `request`/`result` jsonb so full CV
contents never reach the dashboard.

Build order is now **shared → api → admin → extension** (`npm run build`). Dev:
`npm run dev:admin` (Vite on :5174, proxies to the local API at :8787).
In production the dashboard is at **`https://api-76-13-177-250.sslip.io/admin`** —
the same sslip.io URL that already has auto-TLS; no new DNS or reverse-proxy needed.
Deploy: `npm run build` on the VPS, ensure `ADMIN_EMAILS` and `BETTER_AUTH_URL`
are set in `apps/api/.env`, then restart the API process.

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
- **DeepSeek key/balance**: all AI features require `DEEPSEEK_API_KEY`; if `/health` reports unconfigured, set the key in local `apps/api/.env` or the VPS env file
- **DeepSeek retries**: `apps/api/src/deepseek.ts` retries 429/5xx responses with backoff, so a temporarily slow run is not necessarily hung
- **Export without auth**: `/api/cvs/export` is intentionally unauthenticated (used for preview renders)
