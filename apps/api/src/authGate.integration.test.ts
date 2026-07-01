/**
 * Guards against the tailoring routes ever becoming reachable without a
 * session. app.test.ts always passes a generatorFactory, which forces
 * testMode=true and bypasses requireAuth entirely (see app.ts) — so it can't
 * catch a regression here. This file boots the app the way production does
 * (no generatorFactory, real Better Auth session check), which needs Postgres
 * for `auth.api.getSession` to resolve. Skipped automatically when the DB
 * can't be reached — see db.integration.test.ts for the same pattern.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createApp } from "./app.js";

const connectionString =
  process.env.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/fyxor";

let dbAvailable = false;
const probe = new Pool({ connectionString });
beforeAll(async () => {
  try {
    await probe.query("SELECT 1");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  } finally {
    await probe.end();
  }
});

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});
afterAll(() => probe.end().catch(() => undefined));

async function startRealApp() {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("tailoring routes reject unauthenticated requests", () => {
  it("skips when the database is unreachable", () => {
    if (dbAvailable) return; // real tests below cover this path
    expect(true).toBe(true);
  });

  it.each([
    ["/api/cvs/tailor"],
    ["/api/tailoring-runs"],
    ["/api/cvs/regenerate"]
  ])("returns 401 with no session for POST %s", async (path) => {
    if (!dbAvailable) return;
    const base = await startRealApp();
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required" });
  });

  it("returns 401 with no session for GET /api/tailoring-runs/:id", async () => {
    if (!dbAvailable) return;
    const base = await startRealApp();
    const response = await fetch(`${base}/api/tailoring-runs/does-not-exist`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required" });
  });
});
