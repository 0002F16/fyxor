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
- A Gemini API key — [get one at Google AI Studio](https://aistudio.google.com) (free tier works)

### Install & configure

```bash
git clone https://github.com/0002F16/fyxor.git
cd fyxor
npm install

cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env — set GEMINI_API_KEY and BETTER_AUTH_SECRET at minimum
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
| `AI_PROVIDER` | `gemini-api` | `gemini-api` \| `openai-api` \| `codex-local` |
| `GEMINI_API_KEY` | — | Required when using Gemini |
| `GEMINI_MODEL` | `gemini-2.5-flash` | |
| `OPENAI_API_KEY` | — | Required when using OpenAI |
| `OPENAI_MODEL` | `gpt-4o-mini` | |
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
| `CCC_LLM_PROVIDER` | LLM provider override inside CCC (defaults to Gemini) |

CCC auto-loads its own `$CCC_ENGINE_ROOT/.env` for its API keys.

---

## API routes

All routes under `/api/*` require a **Better Auth bearer token** except where noted.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | API + CCC availability status |
| POST | `/api/profile/parse-file` | None | Upload PDF/DOCX → raw text |
| POST | `/api/profile/extract` | Required | Raw text → structured `BaseProfile` |
| POST | `/api/profile/categorize-skills` | Required | Skills list → categorized skills |
| POST | `/api/cvs/tailor` | Required | Profile + job → `TailoredCv` (CCC or built-in) |
| POST | `/api/cvs/regenerate` | Required | Regenerate one section of a tailored CV |
| GET | `/api/data/sync` | Required | Pull user data from Postgres |
| PUT | `/api/data/sync` | Required | Push user data to Postgres |
| GET | `/api/data/usage` | Required | Monthly tailor count for the user |
| POST | `/api/cvs/export` | None | Render CV to DOCX or PDF |

The extension can override the AI provider per-request with the `x-ai-provider` header.

---

## Features

- **Auto LinkedIn capture** — content script detects the current job on any LinkedIn jobs page, including collection/detail-pane URLs where `currentJobId` changes without a page reload
- **Selection fallback** — highlight any text on any site, right-click **Send selection to Fyxor**, continue in the popup
- **Guided onboarding** — PDF/DOCX/text upload with LLM extraction and editable profile confirmation
- **Inline editor** — every field is `contentEditable`, autosaves on blur, section reordering via ▲▼, A4 page guides while editing
- **Per-section regeneration** — hover a section heading for the **Regenerate** button
- **Resume quality checks** — scores completeness before export; `unsupportedClaims` warns but doesn't block export
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
- Usage is tracked in `usage_events`. Set `FREE_MONTHLY_TAILORS` to a non-zero value to cap free tailors/month (returns `402` when exceeded). Usage is only meterable for server-side AI providers (`gemini-api`, `openai-api`); `codex-local` runs on the user's machine.

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
| Quota errors | OpenAI key exhausted | Switch to `AI_PROVIDER=gemini-api` |
| `skillCategories` dropped after tailor | `foldSkillCategories()` not called after LLM response | Ensure it runs after every tailor/regenerate/extract in `apps/api/src/app.ts` |
