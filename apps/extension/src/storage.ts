import { emptyStorageState, migrateStorage, type AuthSession, type JobDescription, type StorageState, type TailoringJob } from "@cv-tailor/shared";

const KEY = "cvTailorState";

export async function getState(): Promise<StorageState> {
  if (!globalThis.chrome?.storage) {
    const local = localStorage.getItem(KEY);
    return migrateStorage(local ? JSON.parse(local) : emptyStorageState());
  }
  const result = await chrome.storage.local.get(KEY);
  return migrateStorage(result[KEY]);
}

export async function setState(state: StorageState): Promise<void> {
  if (!globalThis.chrome?.storage) {
    localStorage.setItem(KEY, JSON.stringify(state));
    return;
  }
  await chrome.storage.local.set({ [KEY]: state });
}

export async function updateState(updater: (state: StorageState) => StorageState): Promise<StorageState> {
  const next = updater(await getState());
  await setState(next);
  return next;
}

export async function queuePendingJob(job: JobDescription): Promise<StorageState> {
  return updateState((state) => ({ ...state, pendingJob: job }));
}

export async function clearPendingJob(): Promise<StorageState> {
  return updateState((state) => ({ ...state, pendingJob: null }));
}

export async function setAuthSession(auth: AuthSession): Promise<StorageState> {
  return updateState((state) => ({ ...state, auth }));
}

// Sign-out clears the session and the local copy of user data; the server stays
// the source of truth, so the next sign-in re-pulls everything.
export async function clearAuthSession(): Promise<StorageState> {
  return updateState((state) => ({ ...state, auth: null, profile: null, drafts: {}, applications: [], pendingJob: null }));
}

// Non-destructive sign-out for an *expired* session: drop only the bearer token
// so the app shows the sign-in gate, but KEEP the local profile/drafts/
// applications. Sync was likely failing on the same 401, so those may hold
// unsynced edits — wiping them would be silent data loss. Re-signing in merges.
export async function clearAuthToken(): Promise<StorageState> {
  return updateState((state) => ({ ...state, auth: null }));
}

export async function getAuthToken(): Promise<string | null> {
  return (await getState()).auth?.token ?? null;
}

export async function upsertTailoringJob(jobKey: string, job: TailoringJob): Promise<StorageState> {
  return updateState((state) => ({ ...state, tailoringJobs: { ...state.tailoringJobs, [jobKey]: job } }));
}

export async function removeTailoringJob(jobKey: string): Promise<StorageState> {
  return updateState((state) => {
    const { [jobKey]: _removed, ...rest } = state.tailoringJobs;
    return { ...state, tailoringJobs: rest };
  });
}
