import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADMIN_EMAILS is read once when app.ts loads, so set it before the import runs.
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = "Admin@Fyxor.eu";
});

// Control the session per-test, and stub the admin DB queries so these run
// without Postgres.
const getSession = vi.fn();
vi.mock("./auth.js", () => ({ auth: { api: { getSession } } }));
vi.mock("./db.js", () => ({
  pool: { query: vi.fn() },
  recordUsage: vi.fn(),
  reserveTailor: vi.fn(),
  releaseUsage: vi.fn(),
  monthlyUsage: vi.fn(),
  listUsers: vi.fn(async () => [
    { id: "u1", email: "user@example.com", name: "User", createdAt: new Date().toISOString(), tailorsThisMonth: 2, tailorsAllTime: 9 }
  ]),
  adminUsageSummary: vi.fn(async () => ({ userCount: 1, tailorsThisMonth: 2, tailorsAllTime: 9, byActionThisMonth: { tailor: 2 } })),
  userDetail: vi.fn(async () => ({ user: { id: "u1", email: "user@example.com", name: "User", createdAt: new Date().toISOString() }, usage: { total: 2, byAction: { tailor: 2 } }, recentRuns: [] }))
}));

const { createApp } = await import("./app");

let base = "";
let close: (() => Promise<void>) | undefined;

beforeEach(async () => {
  // No generator factory → real auth/admin gating (not testMode).
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await close?.();
  close = undefined;
  getSession.mockReset();
});

describe("admin API gating", () => {
  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValue(null);
    const res = await fetch(`${base}/api/admin/users`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a signed-in non-admin", async () => {
    getSession.mockResolvedValue({ user: { id: "u9", email: "nobody@example.com" } });
    const res = await fetch(`${base}/api/admin/users`);
    expect(res.status).toBe(403);
  });

  it("returns the user list for an allowlisted admin (case-insensitive)", async () => {
    getSession.mockResolvedValue({ user: { id: "a1", email: "admin@fyxor.eu" } });
    const res = await fetch(`${base}/api/admin/users`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users[0]).toMatchObject({ email: "user@example.com", tailorsThisMonth: 2, tailorsAllTime: 9 });
  });

  it("serves the platform summary for an admin", async () => {
    getSession.mockResolvedValue({ user: { id: "a1", email: "admin@fyxor.eu" } });
    const res = await fetch(`${base}/api/admin/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ userCount: 1, tailorsThisMonth: 2, tailorsAllTime: 9 });
  });
});
