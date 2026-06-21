import type { AuthSession } from "@cv-tailor/shared";

export class AuthError extends Error {}

// Thin wrapper over Better Auth's email endpoints. We deliberately avoid the
// cookie-based client: in an MV3 extension the reliable path is the bearer
// token, which the server returns in the `set-auth-token` response header.
async function call(base: string, path: string, body: unknown): Promise<AuthSession> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw new AuthError("Can't reach the Fyxor server. Check your connection and the server URL in Account settings.");
  }
  const data = (await response.json().catch(() => ({}))) as {
    token?: string;
    user?: { id?: string; email?: string; name?: string };
    session?: { expiresAt?: string };
    message?: string;
    error?: string;
  };
  if (!response.ok) throw new AuthError(data.message || data.error || `Request failed (${response.status})`);
  const token = response.headers.get("set-auth-token") || data.token;
  const user = data.user;
  if (!token || !user?.id) throw new AuthError("Unexpected response from the server.");
  return {
    userId: user.id,
    email: user.email || "",
    name: user.name || "",
    token,
    expiresAt: data.session?.expiresAt ? String(data.session.expiresAt) : ""
  };
}

export const authClient = {
  signUp: (base: string, email: string, password: string, name: string) =>
    call(base, "sign-up/email", { email, password, name: name || email }),
  signIn: (base: string, email: string, password: string) =>
    call(base, "sign-in/email", { email, password }),
  signOut: async (base: string, token: string) => {
    try {
      await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best effort — the local session is cleared regardless.
    }
  }
};
