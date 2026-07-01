# Fyxor — CV Tailor

AI-powered Chrome extension that tailors your CV to a job description in seconds. Paste or auto-capture a LinkedIn job, the app rewrites your base profile CV for that role, and the result opens in a Google Docs-style inline-editable canvas.

## Architecture

```
apps/
  extension/   Chrome extension (Manifest V3), React + Vite
  api/         Express API — LLM integration, DOCX/PDF export, auth, Postgres
packages/
  shared/      Zod schemas, storage logic, CvDocument React component
```

`packages/shared` is compiled to a dist that both `apps/` import. **Always build shared first** — a stale dist silently drops new schema fields.

---

## Quick start (local)

### Prerequisites

- Node 20+
- Docker (for Postgres)
- A DeepSeek API key — create separate dev and production keys in the DeepSeek platform

### Install & configure

```bash
git clone https://github.com/0002F16/fyxor.git
cd fyxor
npm install

cp .env.example apps/api/.env
# Edit apps/api/.env — set DEEPSEEK_API_KEY and BETTER_AUTH_SECRET at minimum
openssl rand -base64 32   # paste output as BETTER_AUTH_SECRET
```

### Start Postgres and run migrations

```bash
docker compose up -d
npx @better-auth/cli migrate   # creates Better Auth user/session/account tables
# App tables (usage_events, user_data) are created automatically on first API start
```

### Start the API

```bash
npm run dev   # Express on http://127.0.0.1:8787, watch mode
```

### Build and load the extension

```bash
npm run dev:extension   # Vite watch build → apps/extension/dist/
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `apps/extension/dist/`
4. Pin **Fyxor**, open a LinkedIn job, and click the icon

> Keep both `npm run dev` and `npm run dev:extension` running in separate terminals during development.

---

## Environment variables (`apps/api/.env`)

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | `deepseek-api` | Runtime provider is hard-locked to DeepSeek; older provider names are normalized |
| `DEEPSEEK_API_KEY` | — | Required for every AI feature |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | Use `deepseek-v4-pro` only if quality testing requires it |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` behind a reverse proxy on VPS |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/fyxor` | Matches `docker-compose.yml` |
| `BETTER_AUTH_SECRET` | — | Generate: `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `http://127.0.0.1:8787` | Set to your VPS `https://` URL in prod |
| `FREE_MONTHLY_TAILORS` | `0` | `0` = unlimited; set a number to cap free tailors/month |

### CCC engine (optional, recommended)

CCC is the **default tailoring engine** — a Python subprocess that produces higher-quality multi-pass rewrites. If it isn't configured, the API falls back to the built-in single-pass engine with a console warning. Check availability at `GET /health` → `ccc.available`.

| Variable | Notes |
|---|---|
| `CCC_ENGINE_ROOT` | Absolute path to the CCC repo root |
| `CCC_PYTHON` | Path to the CCC venv Python (defaults to `$CCC_ENGINE_ROOT/.venv/bin/python3`) |
| `ENABLE_LEGACY_ENGINES` | Internal rollback/benchmark flag. Default `false`; users always use the unified evidence-first pipeline. |

CCC auto-loads its own `$CCC_ENGINE_ROOT/.env`, but this app passes DeepSeek
credentials explicitly when the legacy CCC path is enabled.

### Unified tailoring pipeline

Normal tailoring runs through evidence planning, constrained writing, and an
independent critic. A targeted repair call runs only when factual checks or the
critic find a must-fix problem. Tailoring uses recoverable `/api/tailoring-runs`
jobs and stores per-bullet evidence. Unified v3 sanitizes recoverable planner and
writer mistakes locally: weak title changes revert to the official title,
unsupported optional content is omitted, certifications are copied exactly from
the base profile, unusable plans fall back to source evidence, and deterministic
coverage floors preserve relevant source skills and bullets. Export is
blocked only while factual failures remain after those recoveries.
The legacy built-in and CCC paths are available only when
`ENABLE_LEGACY_ENGINES=true`.

---

## API routes

All routes under `/api/*` require a **Better Auth bearer token** except where noted.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | API + CCC availability status |
| POST | `/api/profile/parse-file` | None | Upload PDF/DOCX → raw text |
| POST | `/api/profile/extract` | Required | Raw text → structured `BaseProfile` |
| POST | `/api/profile/categorize-skills` | Required | Skills list → categorized skills |
| POST | `/api/tailoring-runs` | Required | Create or reuse a recoverable unified tailoring run |
| GET | `/api/tailoring-runs/:id` | Required | Poll real pipeline stage, progress, findings, and result |
| DELETE | `/api/tailoring-runs/:id` | Required | Cancel a recoverable tailoring run |
| POST | `/api/cvs/tailor` | Required | Compatibility wrapper for older extension clients |
| POST | `/api/cvs/regenerate` | Required | Regenerate one section and return a section patch |
| GET | `/api/data/sync` | Required | Pull user data from Postgres |
| PUT | `/api/data/sync` | Required | Push user data to Postgres |
| GET | `/api/data/usage` | Required | Monthly tailor count for the user |
| POST | `/api/cvs/export` | Required | Revalidate evidence and the exact PDF/DOCX before download |
| POST | `/api/cvs/export` | None | Render CV to DOCX or PDF |

The API normalizes all `x-ai-provider` values to DeepSeek. New and existing
extension installs store `deepseek-api`; Advanced settings shows the provider as
locked.

---

## Features

- **Auto LinkedIn capture** — content script detects the current job on any LinkedIn jobs page, including collection/detail-pane URLs where `currentJobId` changes without a page reload
- **Selection fallback** — highlight any text on any site, right-click **Send selection to Fyxor**, continue in the popup
- **Guided onboarding** — PDF/DOCX/text upload with LLM extraction and editable profile confirmation
- **Inline editor** — every field is `contentEditable`, autosaves on blur, section reordering via ▲▼, A4 page guides while editing
- **Per-section regeneration** — hover a section heading for the **Regenerate** button
- **Evidence-first quality checks** — separate Evidence, Relevance, Readability, ATS, and Appropriateness signals; unresolved factual failures block export
- **Export** — DOCX and PDF, honoring custom section order
- **Tracker** — local read-only view of all tailored drafts
- **Cloud sync** — sign in to push/pull profile and drafts to Postgres (last-write-wins, debounced)
- **Self-hosted auth** — Better Auth runs inside the API; no third-party auth service
- **English and Polish** output

---

## Accounts & cloud sync

- Sign-up is required before onboarding or tailoring (email + password only).
- The extension authenticates with a bearer token stored in `chrome.storage.local` — the reliable pattern for an MV3 extension calling a cross-origin server.
- On sign-in the extension pulls `profile`/`drafts`/`applications` from `GET /api/data/sync`; local edits are pushed back (debounced, last-write-wins) to `PUT /api/data/sync`.
- Usage is tracked in `usage_events`. Set `FREE_MONTHLY_TAILORS` to a non-zero value to cap free tailors/month (returns `402` when exceeded). All AI usage runs server-side through DeepSeek.

---

## Deploying to a VPS

The live API runs at `https://api-76-13-177-250.sslip.io`.

1. SSH: `ssh root@76.13.177.250`
2. Set `HOST=0.0.0.0`, `BETTER_AUTH_URL=https://your-domain`, `DATABASE_URL` in `apps/api/.env`
3. Run Postgres via `docker-compose.yml`; put the API behind Caddy or Nginx for TLS
4. Add your `https://` origin to `host_permissions` in `apps/extension/public/manifest.json` and rebuild the extension
5. In the extension's **Account** settings, point **Local server URL** at your VPS URL

---

## Commands

```bash
npm run build           # shared → api → extension (correct order)
npm run dev             # API in watch mode (port 8787)
npm run dev:extension   # Extension Vite watch build
npm test                # vitest (all *.test.ts files)
npm run typecheck       # typecheck all workspaces
```

Integration tests (`db.integration.test.ts`) require a live Postgres connection. All other tests run with `environment: "node"`.

---

## Common gotchas

| Problem | Cause | Fix |
|---|---|---|
| New schema fields silently missing | Stale `packages/shared/dist` | `npm run build -w @cv-tailor/shared` |
| User sees sign-in screen, all data gone | Invalid field in stored `auth` object triggers a full reset to empty state | Check Chrome DevTools → Application → Local Storage |
| Tailoring seems low quality | CCC not configured, fell back to built-in | Check `GET /health` → `ccc.available`; set `CCC_ENGINE_ROOT` |
| Quota errors | DeepSeek key exhausted or rate-limited | Verify `DEEPSEEK_API_KEY`, DeepSeek balance, and provider rate limits |
| `skillCategories` dropped after tailor | `foldSkillCategories()` not called after LLM response | Ensure it runs after every tailor/regenerate/extract in `apps/api/src/app.ts` |
