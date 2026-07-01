import type { AiProvider, BaseProfile, JobDescription, RegenerationPatch, RegenerationRequest, SyncPayload, TailoredCv, TailoringEngine, TailoringRunStatus } from "@cv-tailor/shared";
import { getAuthToken } from "./storage";

export class ApiError extends Error {}
// Thrown on a 401 so the UI can drop the stale session and show the sign-in gate.
export class AuthExpiredError extends ApiError {}

// Default request timeout. Tailoring is much slower (CCC's multi-step pipeline can
// run several minutes), so callers below override it with TAILOR_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 30_000;
// 15 min — comfortably covers a CCC + DeepSeek multi-step run while staying under CCC's
// 20-min server cap (cccEngine RUN_TIMEOUT_MS). The orphan watchdogs (background
// STALE_TAILORING_MS / popup STALE_MS) must stay greater than this.
const TAILOR_TIMEOUT_MS = 900_000;

async function request<T>(baseUrl: string, provider: AiProvider, path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS, externalSignal?: AbortSignal): Promise<T> {
  void provider;
  const token = await getAuthToken();
  // Abort the fetch if the server never responds, so a hung request surfaces a
  // clear error instead of spinning forever. When the caller also passes a
  // cancel signal (e.g. the user hit Cancel on a tailoring), abort on either.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-ai-provider": "deepseek-api",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers
      }
    });
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") {
      throw new ApiError("The request timed out — the server took too long to respond. Please try again.");
    }
    throw new ApiError("The Fyxor API is offline. Check the server URL in Account settings (or run `npm run dev -w @cv-tailor/api`).");
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new AuthExpiredError("Your session expired. Please sign in again.");
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  health: (base: string, provider: AiProvider) =>
    request<{ ok: boolean; configured: boolean; model: string; provider: AiProvider; ccc?: { available: boolean; engineRoot: string; python: string } }>(base, provider, "/health"),
  parseFile: (base: string, provider: AiProvider, base64: string, fileName: string) =>
    request<{ text: string }>(base, provider, "/api/profile/parse-file", { method: "POST", body: JSON.stringify({ base64, fileName }) }),
  extract: (base: string, provider: AiProvider, text: string) =>
    request<BaseProfile>(base, provider, "/api/profile/extract", { method: "POST", body: JSON.stringify({ text }) }),
  categorizeSkills: (base: string, provider: AiProvider, skills: string[], targetRole = "") =>
    request<{ skillCategories: Record<string, string[]>; skills: string[] }>(base, provider, "/api/profile/categorize-skills", { method: "POST", body: JSON.stringify({ skills, targetRole }) }),
  tailoringRun: (base: string, provider: AiProvider, runId: string, signal?: AbortSignal) =>
    request<TailoringRunStatus>(base, provider, `/api/tailoring-runs/${runId}`, undefined, DEFAULT_TIMEOUT_MS, signal),
  cancelTailoringRun: (base: string, provider: AiProvider, runId: string) =>
    request<TailoringRunStatus>(base, provider, `/api/tailoring-runs/${runId}`, { method: "DELETE" }),
  tailor: async (
    base: string,
    provider: AiProvider,
    profile: BaseProfile,
    job: JobDescription,
    _tailoringEngine: TailoringEngine = "builtin",
    signal?: AbortSignal,
    onProgress?: (run: TailoringRunStatus) => void | Promise<void>
  ) => {
    const run = await request<TailoringRunStatus>(
      base,
      provider,
      "/api/tailoring-runs",
      { method: "POST", body: JSON.stringify({ profile, job }) },
      DEFAULT_TIMEOUT_MS,
      signal
    );
    onProgress?.(run);
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException("Tailoring cancelled", "AbortError");
        const current = await request<TailoringRunStatus>(base, provider, `/api/tailoring-runs/${run.id}`, undefined, DEFAULT_TIMEOUT_MS, signal);
        await onProgress?.(current);
        if (current.status === "completed" && current.cv) return current.cv;
        if (current.status === "failed" || current.status === "cancelled") {
          throw new ApiError(current.error || `Tailoring ${current.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (signal?.aborted) {
        await request(base, provider, `/api/tailoring-runs/${run.id}`, { method: "DELETE" }).catch(() => undefined);
        throw new DOMException("Tailoring cancelled", "AbortError");
      }
      throw error;
    }
  },
  regenerate: (base: string, provider: AiProvider, input: RegenerationRequest) =>
    request<RegenerationPatch>(base, provider, "/api/cvs/regenerate", { method: "POST", body: JSON.stringify(input) }, TAILOR_TIMEOUT_MS),
  pullSync: (base: string, provider: AiProvider) =>
    request<SyncPayload>(base, provider, "/api/data/sync"),
  pushSync: (base: string, provider: AiProvider, payload: SyncPayload) =>
    request<{ ok: boolean }>(base, provider, "/api/data/sync", { method: "PUT", body: JSON.stringify(payload) }),
  usage: (base: string, provider: AiProvider) =>
    request<{ total: number; byAction: Record<string, number> }>(base, provider, "/api/data/usage"),
  export: async (base: string, provider: AiProvider, profile: BaseProfile, cv: TailoredCv, format: "pdf" | "docx") => {
    void provider;
    // Mirror request()'s timeout so a hung export surfaces a clear error instead
    // of spinning "Creating PDF…" forever. (Export returns a binary blob, not
    // JSON, so it can't reuse request() directly.)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      const token = await getAuthToken();
      response = await fetch(`${base}/api/cvs/export?format=${format}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-ai-provider": "deepseek-api", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ profile, cv }), signal: controller.signal
      });
    } catch (cause) {
      if ((cause as Error)?.name === "AbortError") throw new ApiError("Export timed out — the server took too long to respond. Please try again.");
      throw new ApiError("The Fyxor API is offline. Check the server URL in Account settings.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const details = Array.isArray(body.findings) ? body.findings.map((finding: { detail?: string; label?: string }) => finding.detail || finding.label).filter(Boolean).join(" ") : "";
      throw new ApiError(`${body.error || "Export failed"}${details ? ` ${details}` : ""}`);
    }
    return response.blob();
  }
};
