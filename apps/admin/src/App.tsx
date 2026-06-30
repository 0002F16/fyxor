import React, { useEffect, useState } from "react";
import { LogOut, RefreshCw, Search, Users, Zap, History } from "lucide-react";
import {
  adminApi,
  ApiError,
  clearToken,
  getToken,
  signIn,
  type AdminRun,
  type AdminSummary,
  type AdminUser,
  type AdminUserDetail
} from "./api";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function App() {
  // A stored token means a prior session; we verify it by loading the summary.
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getToken()));
  const [bootChecked, setBootChecked] = useState(false);

  useEffect(() => {
    if (!getToken()) { setBootChecked(true); return; }
    adminApi.summary()
      .then(() => setAuthed(true))
      .catch(() => { clearToken(); setAuthed(false); })
      .finally(() => setBootChecked(true));
  }, []);

  if (!bootChecked) return <div className="grid min-h-screen place-items-center text-sm text-muted">Loading…</div>;
  if (!authed) return <SignIn onSignedIn={() => setAuthed(true)} />;
  return <Dashboard onSignOut={() => { clearToken(); setAuthed(false); }} />;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn(email, password);
      // Confirm the account is actually an admin before entering.
      await adminApi.summary();
      onSignedIn();
    } catch (err) {
      clearToken();
      if (err instanceof ApiError && err.status === 403) setError("This account is not an admin.");
      else setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm">
        <h1 className="section-title mb-1">Fyxor Admin</h1>
        <p className="mb-5 text-sm text-muted">Sign in with an admin account.</p>
        <label className="label">Email</label>
        <input className="field mb-3" type="email" value={email} autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} required />
        <label className="label">Password</label>
        <input className="field mb-4" type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}
        <button className="btn-primary w-full" disabled={busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = async (searchTerm = "") => {
    setLoading(true);
    setError("");
    try {
      const [s, u] = await Promise.all([adminApi.summary(), adminApi.users(searchTerm)]);
      setSummary(s);
      setUsers(u.users);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return onSignOut();
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="section-title">Fyxor Admin</h1>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => load(search)} title="Refresh">
            <RefreshCw size={16} /> Refresh
          </button>
          <button className="btn-secondary" onClick={onSignOut}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={<Users size={18} />} label="Total users" value={summary?.userCount} />
        <StatCard icon={<Zap size={18} />} label="Tailors this month" value={summary?.tailorsThisMonth} />
        <StatCard icon={<History size={18} />} label="Tailors all-time" value={summary?.tailorsAllTime} />
      </div>

      <div className="card">
        <div className="mb-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              className="field pl-9"
              placeholder="Search by email or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void load(search); }}
            />
          </div>
          <button className="btn-secondary" onClick={() => load(search)}>Search</button>
        </div>

        {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}
        {loading ? (
          <p className="py-8 text-center text-sm text-muted">Loading…</p>
        ) : users.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No users found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-4 font-semibold">Email</th>
                  <th className="py-2 pr-4 font-semibold">Joined</th>
                  <th className="py-2 pr-4 text-right font-semibold">This month</th>
                  <th className="py-2 text-right font-semibold">All-time</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="cursor-pointer border-b border-line/60 hover:bg-soft"
                    onClick={() => setSelected(u.id)}
                  >
                    <td className="py-2.5 pr-4">
                      <div className="font-medium text-ink">{u.email}</div>
                      {u.name && <div className="text-xs text-muted">{u.name}</div>}
                    </td>
                    <td className="py-2.5 pr-4 text-muted">{fmtDate(u.createdAt)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{u.tailorsThisMonth}</td>
                    <td className="py-2.5 text-right tabular-nums">{u.tailorsAllTime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && <UserDetailModal userId={selected} onClose={() => setSelected(null)} onAuthLost={onSignOut} />}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value?: number }) {
  return (
    <div className="card flex items-center gap-4">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-mint text-deep">{icon}</div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
        <div className="text-2xl font-bold tabular-nums text-ink">{value ?? "—"}</div>
      </div>
    </div>
  );
}

function UserDetailModal({ userId, onClose, onAuthLost }: { userId: string; onClose: () => void; onAuthLost: () => void }) {
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi.userDetail(userId)
      .then(setDetail)
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return onAuthLost();
        setError(err instanceof Error ? err.message : "Failed to load.");
      });
  }, [userId]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div className="card max-h-[85vh] w-full max-w-2xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : !detail ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="section-title">{detail.user.email}</h2>
                <p className="text-sm text-muted">
                  {detail.user.name || "—"} · joined {fmtDate(detail.user.createdAt)}
                </p>
              </div>
              <button className="btn-secondary" onClick={onClose}>Close</button>
            </div>

            <h3 className="label">Usage this month</h3>
            <div className="mb-5 flex flex-wrap gap-2">
              <span className="chip">total {detail.usage.total}</span>
              {Object.entries(detail.usage.byAction).map(([action, n]) => (
                <span key={action} className="chip">{action} {n}</span>
              ))}
              {detail.usage.total === 0 && <span className="text-sm text-muted">No activity this month.</span>}
            </div>

            <h3 className="label">Recent tailoring runs</h3>
            {detail.recentRuns.length === 0 ? (
              <p className="text-sm text-muted">No runs yet.</p>
            ) : (
              <div className="space-y-1.5">
                {detail.recentRuns.map((r) => <RunRow key={r.id} run={r} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: AdminRun }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-line/60 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className={`run-pill run-${run.status}`}>{run.status}</span>
        <span className="text-muted">{run.stage}</span>
        <span className="text-xs text-muted">· {run.provider}</span>
      </div>
      <div className="text-right">
        <div className="text-xs text-muted">{new Date(run.updatedAt).toLocaleString()}</div>
        {run.error && <div className="max-w-[16rem] truncate text-xs text-rose-600" title={run.error}>{run.error}</div>}
      </div>
    </div>
  );
}
