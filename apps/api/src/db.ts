import { Pool } from "pg";

// Single shared connection pool. Better Auth uses this same pool (via its
// built-in Kysely adapter) for its own tables, and our app data routes use it
// for the `user_data` / `usage_events` tables created below.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/fyxor"
});

// App-owned tables. Better Auth's own tables (user, session, account,
// verification) are created separately via `npx @better-auth/cli migrate`.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_data (
    user_id text PRIMARY KEY,
    profile jsonb,
    drafts jsonb NOT NULL DEFAULT '{}'::jsonb,
    applications jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    action text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    meta jsonb
  );
  CREATE INDEX IF NOT EXISTS usage_events_user_month
    ON usage_events (user_id, created_at);
  CREATE TABLE IF NOT EXISTS tailoring_runs (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    idempotency_key text NOT NULL,
    pipeline_version text NOT NULL,
    provider text NOT NULL,
    status text NOT NULL,
    stage text NOT NULL,
    progress integer NOT NULL DEFAULT 0,
    request jsonb,
    result jsonb,
    evaluation jsonb,
    metadata jsonb,
    usage_event_id bigint,
    error text NOT NULL DEFAULT '',
    cancel_requested boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key, pipeline_version)
  );
  ALTER TABLE tailoring_runs ADD COLUMN IF NOT EXISTS usage_event_id bigint;
  ALTER TABLE tailoring_runs ADD COLUMN IF NOT EXISTS started_at timestamptz;
  ALTER TABLE tailoring_runs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
  CREATE INDEX IF NOT EXISTS tailoring_runs_user_updated
    ON tailoring_runs (user_id, updated_at DESC);
`;

export async function initDb(): Promise<void> {
  await pool.query(SCHEMA);
}

export async function recordUsage(userId: string, action: string, meta?: unknown): Promise<void> {
  await pool.query(
    "INSERT INTO usage_events (user_id, action, meta) VALUES ($1, $2, $3)",
    [userId, action, meta == null ? null : JSON.stringify(meta)]
  );
}

// Atomically reserve a "tailor" slot against the monthly free cap. The count and
// the insert run inside one transaction guarded by a per-user advisory lock, so
// concurrent tailor requests can't all read a sub-cap count and slip through
// (the TOCTOU that made the cap bypassable). Returns the inserted event id on
// success so a failed tailor can release it via `releaseUsage`.
export async function reserveTailor(userId: string, limit: number): Promise<{ ok: boolean; eventId?: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize check+insert per user; the lock releases automatically at COMMIT.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM usage_events
         WHERE user_id = $1 AND action = 'tailor' AND created_at >= date_trunc('month', now())`,
      [userId]
    );
    if (Number(rows[0]?.count ?? 0) >= limit) {
      await client.query("ROLLBACK");
      return { ok: false };
    }
    const { rows: inserted } = await client.query<{ id: string }>(
      "INSERT INTO usage_events (user_id, action) VALUES ($1, 'tailor') RETURNING id",
      [userId]
    );
    await client.query("COMMIT");
    return { ok: true, eventId: inserted[0]?.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Compensating delete for a reservation whose tailor ultimately failed, so a
// crashed/errored run never burns a free-tier slot.
export async function releaseUsage(eventId: string): Promise<void> {
  await pool.query("DELETE FROM usage_events WHERE id = $1", [eventId]);
}

// Count of usage events for the current calendar month, grouped by action.
export async function monthlyUsage(userId: string): Promise<{ total: number; byAction: Record<string, number> }> {
  const { rows } = await pool.query<{ action: string; count: string }>(
    `SELECT action, count(*)::int AS count FROM usage_events
       WHERE user_id = $1 AND created_at >= date_trunc('month', now())
       GROUP BY action`,
    [userId]
  );
  const byAction: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const n = Number(row.count);
    byAction[row.action] = n;
    total += n;
  }
  return { total, byAction };
}

// --- Admin (read-only) queries ---------------------------------------------
// These join Better Auth's own `user` table (camelCase columns, so quoted) with
// the app-owned usage tables. They're only reachable behind the admin allowlist
// gate in app.ts; nothing here mutates data.

export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  tailorsThisMonth: number;
  tailorsAllTime: number;
};

// Account list with each user's tailor counts (this month + lifetime). Optional
// case-insensitive email/name search and pagination.
export async function listUsers(opts: { search?: string; limit?: number; offset?: number } = {}): Promise<AdminUserRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = opts.search?.trim();
  const params: unknown[] = [];
  let where = "";
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE u.email ILIKE $${params.length} OR u.name ILIKE $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query<{
    id: string; email: string; name: string | null; createdAt: Date;
    tailors_month: string; tailors_all: string;
  }>(
    `SELECT u.id,
            u.email,
            u.name,
            u."createdAt" AS "createdAt",
            count(e.id) FILTER (
              WHERE e.action = 'tailor' AND e.created_at >= date_trunc('month', now())
            )::int AS tailors_month,
            count(e.id) FILTER (WHERE e.action = 'tailor')::int AS tailors_all
       FROM "user" u
       LEFT JOIN usage_events e ON e.user_id = u.id
       ${where}
       GROUP BY u.id, u.email, u.name, u."createdAt"
       ORDER BY u."createdAt" DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name ?? "",
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    tailorsThisMonth: Number(r.tailors_month),
    tailorsAllTime: Number(r.tailors_all)
  }));
}

// Platform-wide rollup for the overview cards.
export async function adminUsageSummary(): Promise<{
  userCount: number;
  tailorsThisMonth: number;
  tailorsAllTime: number;
  byActionThisMonth: Record<string, number>;
}> {
  const [{ rows: userRows }, { rows: tailorRows }, { rows: actionRows }] = await Promise.all([
    pool.query<{ count: string }>(`SELECT count(*)::int AS count FROM "user"`),
    pool.query<{ month: string; all: string }>(
      `SELECT count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS month,
              count(*)::int AS all
         FROM usage_events WHERE action = 'tailor'`
    ),
    pool.query<{ action: string; count: string }>(
      `SELECT action, count(*)::int AS count FROM usage_events
         WHERE created_at >= date_trunc('month', now())
         GROUP BY action`
    )
  ]);
  const byActionThisMonth: Record<string, number> = {};
  for (const r of actionRows) byActionThisMonth[r.action] = Number(r.count);
  return {
    userCount: Number(userRows[0]?.count ?? 0),
    tailorsThisMonth: Number(tailorRows[0]?.month ?? 0),
    tailorsAllTime: Number(tailorRows[0]?.all ?? 0),
    byActionThisMonth
  };
}

// Platform-wide + per-user in-flight run counts, for the admin "live load" card.
export async function queueStatus(): Promise<{
  queued: number;
  running: number;
  runningByUser: Array<{ userId: string; email: string; running: number; queued: number }>;
}> {
  const [{ rows: totals }, { rows: byUser }] = await Promise.all([
    pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::int AS count FROM tailoring_runs
         WHERE status IN ('queued','running') GROUP BY status`
    ),
    pool.query<{ user_id: string; email: string; running: string; queued: string }>(
      `SELECT r.user_id, u.email,
              count(*) FILTER (WHERE r.status = 'running')::int AS running,
              count(*) FILTER (WHERE r.status = 'queued')::int AS queued
         FROM tailoring_runs r
         JOIN "user" u ON u.id = r.user_id
         WHERE r.status IN ('queued','running')
         GROUP BY r.user_id, u.email
         ORDER BY count(*) DESC
         LIMIT 20`
    )
  ]);
  let queued = 0;
  let running = 0;
  for (const row of totals) {
    if (row.status === "queued") queued = Number(row.count);
    if (row.status === "running") running = Number(row.count);
  }
  return {
    queued,
    running,
    runningByUser: byUser.map((r) => ({
      userId: r.user_id,
      email: r.email,
      running: Number(r.running),
      queued: Number(r.queued)
    }))
  };
}

export type AdminRunSummary = {
  id: string;
  status: string;
  stage: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string;
};

// One user's profile + monthly usage + recent tailoring runs. The run rows omit
// the request/result jsonb so full CV contents never reach the dashboard.
export async function userDetail(userId: string, runLimit = 20): Promise<{
  user: { id: string; email: string; name: string; createdAt: string } | null;
  usage: { total: number; byAction: Record<string, number> };
  recentRuns: AdminRunSummary[];
}> {
  const [{ rows: userRows }, usage, { rows: runRows }] = await Promise.all([
    pool.query<{ id: string; email: string; name: string | null; createdAt: Date }>(
      `SELECT id, email, name, "createdAt" AS "createdAt" FROM "user" WHERE id = $1`,
      [userId]
    ),
    monthlyUsage(userId),
    pool.query<{
      id: string; status: string; stage: string; provider: string;
      created_at: Date; updated_at: Date; started_at: Date | null; finished_at: Date | null; error: string;
    }>(
      `SELECT id, status, stage, provider, created_at, updated_at, started_at, finished_at, error
         FROM tailoring_runs WHERE user_id = $1
         ORDER BY updated_at DESC LIMIT $2`,
      [userId, Math.min(Math.max(runLimit, 1), 100)]
    )
  ]);
  const u = userRows[0];
  return {
    user: u
      ? { id: u.id, email: u.email, name: u.name ?? "", createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt) }
      : null,
    usage,
    recentRuns: runRows.map((r) => ({
      id: r.id,
      status: r.status,
      stage: r.stage,
      provider: r.provider,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      startedAt: r.started_at ? r.started_at.toISOString() : null,
      finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
      error: r.error ?? ""
    }))
  };
}
