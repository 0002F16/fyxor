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
