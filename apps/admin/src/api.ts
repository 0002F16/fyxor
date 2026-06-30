// API client for the admin dashboard. Auth reuses Better Auth's bearer flow (the
// same one the extension uses): sign-in returns the session token in the
// `set-auth-token` response header, which we send back as `Authorization: Bearer`.

// Same-origin in production (served by the API at /admin); a local API in dev.
const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  (import.meta.env.DEV ? "http://127.0.0.1:8787" : "");

const TOKEN_KEY = "fyxorAdminToken";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {})
      }
    });
  } catch {
    throw new ApiError("Can't reach the Fyxor server.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(String(data.error || data.message || `Request failed (${res.status})`), res.status);
  }
  return data as T;
}

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  tailorsThisMonth: number;
  tailorsAllTime: number;
};

export type AdminSummary = {
  userCount: number;
  tailorsThisMonth: number;
  tailorsAllTime: number;
  byActionThisMonth: Record<string, number>;
};

export type AdminRun = {
  id: string;
  status: string;
  stage: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  error: string;
};

export type AdminUserDetail = {
  user: { id: string; email: string; name: string; createdAt: string };
  usage: { total: number; byAction: Record<string, number> };
  recentRuns: AdminRun[];
};

export async function signIn(email: string, password: string): Promise<{ email: string }> {
  const res = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  }).catch(() => {
    throw new ApiError("Can't reach the Fyxor server.", 0);
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; user?: { email?: string }; error?: string; message?: string };
  if (!res.ok) throw new ApiError(String(data.message || data.error || `Sign in failed (${res.status})`), res.status);
  const token = res.headers.get("set-auth-token") || data.token;
  if (!token) throw new ApiError("Unexpected response from the server.", res.status);
  setToken(token);
  return { email: data.user?.email || email };
}

export const adminApi = {
  summary: () => request<AdminSummary>("/api/admin/summary"),
  users: (search?: string) =>
    request<{ users: AdminUser[] }>(`/api/admin/users${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  userDetail: (id: string) => request<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`)
};
