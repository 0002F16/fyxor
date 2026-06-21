import type { AiProvider, BaseProfile, JobDescription, RegenerationRequest, SyncPayload, TailoredCv, TailoringEngine } from "@cv-tailor/shared";
import { getAuthToken } from "./storage";

export class ApiError extends Error {}
// Thrown on a 401 so the UI can drop the stale session and show the sign-in gate.
export class AuthExpiredError extends ApiError {}

// Default request timeout. Tailoring is much slower (CCC can run a minute or
// two), so callers below override it with TAILOR_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 30_000;
const TAILOR_TIMEOUT_MS = 300_000;

async function request<T>(baseUrl: string, provider: AiProvider, path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS, externalSignal?: AbortSignal): Promise<T> {
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
        "x-ai-provider": provider,
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
  extract: (base: string, provider: AiProvider, text: string, outputLanguage: "en" | "pl") =>
    request<BaseProfile>(base, provider, "/api/profile/extract", { method: "POST", body: JSON.stringify({ text, outputLanguage }) }),
  categorizeSkills: (base: string, provider: AiProvider, skills: string[], targetRole = "") =>
    request<{ skillCategories: Record<string, string[]>; skills: string[] }>(base, provider, "/api/profile/categorize-skills", { method: "POST", body: JSON.stringify({ skills, targetRole }) }),
  tailor: (base: string, provider: AiProvider, profile: BaseProfile, job: JobDescription, tailoringEngine: TailoringEngine = "builtin", signal?: AbortSignal) =>
    request<TailoredCv>(base, provider, "/api/cvs/tailor", { method: "POST", headers: { "x-tailoring-engine": tailoringEngine }, body: JSON.stringify({ profile, job, tailoringEngine }) }, TAILOR_TIMEOUT_MS, signal),
  regenerate: (base: string, provider: AiProvider, input: RegenerationRequest) =>
    request<TailoredCv>(base, provider, "/api/cvs/regenerate", { method: "POST", body: JSON.stringify(input) }, TAILOR_TIMEOUT_MS),
  pullSync: (base: string, provider: AiProvider) =>
    request<SyncPayload>(base, provider, "/api/data/sync"),
  pushSync: (base: string, provider: AiProvider, payload: SyncPayload) =>
    request<{ ok: boolean }>(base, provider, "/api/data/sync", { method: "PUT", body: JSON.stringify(payload) }),
  usage: (base: string, provider: AiProvider) =>
    request<{ total: number; byAction: Record<string, number> }>(base, provider, "/api/data/usage"),
  export: async (base: string, provider: AiProvider, cv: TailoredCv, format: "pdf" | "docx") => {
    // Mirror request()'s timeout so a hung export surfaces a clear error instead
    // of spinning "Creating PDF…" forever. (Export returns a binary blob, not
    // JSON, so it can't reuse request() directly.)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/api/cvs/export?format=${format}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-ai-provider": provider }, body: JSON.stringify({ cv }), signal: controller.signal
      });
    } catch (cause) {
      if ((cause as Error)?.name === "AbortError") throw new ApiError("Export timed out — the server took too long to respond. Please try again.");
      throw new ApiError("The Fyxor API is offline. Check the server URL in Account settings.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ApiError((await response.json().catch(() => ({}))).error || "Export failed");
    return response.blob();
  }
};
