import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { pool } from "./db.js";

// Self-hosted auth: Better Auth runs inside this Express server and stores its
// tables in our own Postgres. No third-party auth service.
//
// The `bearer()` plugin is what makes this work from an MV3 Chrome extension:
// on sign-in it returns the session token in a `set-auth-token` response header
// and accepts `Authorization: Bearer <token>` on subsequent requests, so we
// avoid cross-origin cookie handling in the extension.
export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET || "dev-insecure-secret-change-me",
  baseURL: process.env.BETTER_AUTH_URL || "http://127.0.0.1:8787",
  emailAndPassword: { enabled: true },
  plugins: [bearer()],
  // The extension's origin is `chrome-extension://<id>`, and the id differs
  // between dev/unpacked and the published build, so trust the scheme. The
  // admin dashboard is same-origin (served by this API) so no extra origin is
  // needed — the sslip.io URL is already covered by BETTER_AUTH_URL in prod.
  trustedOrigins: ["chrome-extension://"]
});
