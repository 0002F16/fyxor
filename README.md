# CV Tailor MVP

Local-first Chrome extension for tailoring a CV against a LinkedIn job listing. The extension stores profile and application data in `chrome.storage.local`; the stateless companion API keeps the OpenAI key outside Chrome.

## Run

```bash
cp .env.example .env
# Codex CLI is the default AI provider. Ensure `codex` is installed and signed in.
# OPENAI_API_KEY is only required when switching to the OpenAI API provider.
npm install

# Accounts + cloud sync need Postgres. Start it and create the auth tables:
docker compose up -d postgres
# Generate a secret and put it in .env as BETTER_AUTH_SECRET:
openssl rand -base64 32
npx @better-auth/cli migrate   # creates Better Auth's user/session/account tables

npm run build
npm run dev
```

For the first run, build and load the unpacked extension:

```bash
npm run build -w @cv-tailor/extension
```

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `apps/extension/dist`.
5. Pin CV Tailor, open a LinkedIn job, and click the extension icon.

The API binds only to `http://127.0.0.1:8787`. Keep `npm run dev` running while using the extension. Run `npm run dev:extension` in a second terminal when actively changing extension code.

## AI providers

- **Codex running on this machine** is the default. The server launches an ephemeral, read-only `codex exec` process for each AI task and validates its final response against the same strict schema used by the API.
- **OpenAI API** uses the Responses API and requires `OPENAI_API_KEY`.
- Switch providers immediately from **Base CV → AI provider**. The localhost server does not need to restart.
- Optional environment controls: `AI_PROVIDER`, `CODEX_PATH`, `CODEX_MODEL`, `OPENAI_MODEL`.

## Accounts & cloud sync

Accounts are **self-hosted** — no third-party auth service. [Better Auth](https://better-auth.com)
runs inside the companion API and stores its tables in your own Postgres, so the
whole stack can live on a single VPS.

- **First use is gated**: the extension shows a sign-up screen before any
  onboarding or tailoring. Email + password only.
- The extension authenticates with a **bearer token** (stored in
  `chrome.storage.local`), which is the reliable pattern for an MV3 extension
  calling a cross-origin server.
- On sign-in the extension pulls the account's `profile`/`drafts`/`applications`
  from `GET /api/data/sync`; local edits are pushed back (debounced,
  last-write-wins) to `PUT /api/data/sync`.
- **Usage tracking**: every server-side AI action is recorded in `usage_events`.
  `GET /api/data/usage` returns this month's counts. Set `FREE_MONTHLY_TAILORS`
  to a non-zero value to cap free tailors per month (returns `402` when exceeded).
  Note: usage is only meterable when AI runs on the server (`openai-api`
  provider); `codex-local` runs on the user's own machine.

### Deploying to a VPS

1. Point `DATABASE_URL` / `BETTER_AUTH_URL` at the server, set `HOST=0.0.0.0`,
   and run Postgres + the API (the included `docker-compose.yml` is the starting
   point; add the API container and a Caddy/Nginx TLS proxy).
2. Add your server's `https://` origin to `host_permissions` in
   `apps/extension/public/manifest.json` (replace the `api.yourdomain.com`
   placeholder) and rebuild the extension.
3. In the extension's **Account** settings, set **Local server URL** to your VPS
   URL.

## MVP behavior

- Guided PDF/DOCX/text onboarding with editable profile confirmation.
- Automatic LinkedIn job capture, including collection/detail-pane URLs where `currentJobId` changes without a page reload.
- A small on-page LinkedIn indicator confirms CV Tailor is active and opens a compact tailoring dialog when clicked.
- Clicking the Chrome toolbar icon on any website opens the compact Chrome popup. Before a job is imported, it explains how to send highlighted job text; on LinkedIn it detects the current job automatically.
- Highlight a job description on any website, right-click **Send selection to CV Tailor**, and continue in the populated popup.
- Honest, source-grounded CV rewriting.
- Editable drafts, per-section regeneration, local tracker, and PDF/DOCX export.
- English interface with English or Polish output.

## Commands

```bash
npm run build
npm test
npm run typecheck
```
