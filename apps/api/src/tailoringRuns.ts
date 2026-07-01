import { createHash } from "node:crypto";
import {
  baseProfileSchema,
  jobDescriptionSchema,
  tailoringRunStatusSchema,
  type AiProvider,
  type BaseProfile,
  type JobDescription,
  type TailoringRunStatus
} from "@cv-tailor/shared";
import { pool, recordUsage, releaseUsage, reserveTailor } from "./db.js";
import type { Generator } from "./openai.js";
import { createGenerator, providerStatus } from "./providers.js";
import { generateUnifiedCv, PIPELINE_VERSION } from "./unifiedPipeline.js";

type RunRequest = { profile: BaseProfile; job: JobDescription };
type StoredRun = TailoringRunStatus & {
  userId: string;
  provider: AiProvider;
  request?: RunRequest;
  cancelRequested: boolean;
  usageEventId?: string;
  startedAt?: string;
  finishedAt?: string;
};

const memoryRuns = new Map<string, StoredRun>();
const activeRuns = new Set<string>();

// Concurrency scheduler: runs are created as "queued" and only actually start
// (via executeRun) once both caps have room, so a burst of requests degrades
// to a FIFO wait instead of piling unbounded work onto this one VPS process.
type QueueEntry = { run: StoredRun; testMode: boolean; generatorFactory?: () => Generator };
const waiting: QueueEntry[] = [];
const activeByUser = new Map<string, number>();
const PER_USER_MAX = Number(process.env.PER_USER_MAX_CONCURRENT_TAILORS) || 3;
const GLOBAL_MAX = Number(process.env.GLOBAL_MAX_CONCURRENT_TAILORS) || 6;

export function schedulerStatus(): { queued: number; running: number; globalMax: number; perUserMax: number } {
  return { queued: waiting.length, running: activeRuns.size, globalMax: GLOBAL_MAX, perUserMax: PER_USER_MAX };
}

function schedule(): void {
  for (let i = 0; i < waiting.length; i++) {
    const entry = waiting[i];
    if (!entry) continue;
    if (entry.run.cancelRequested) {
      waiting.splice(i, 1);
      i--;
      continue;
    }
    if (activeRuns.size >= GLOBAL_MAX) break;
    if ((activeByUser.get(entry.run.userId) || 0) >= PER_USER_MAX) continue;
    waiting.splice(i, 1);
    i--;
    startEntry(entry);
  }
}

function startEntry(entry: QueueEntry): void {
  const userId = entry.run.userId;
  activeByUser.set(userId, (activeByUser.get(userId) || 0) + 1);
  void executeRun(entry.run, entry.testMode, entry.generatorFactory).finally(() => {
    const remaining = (activeByUser.get(userId) || 1) - 1;
    if (remaining <= 0) activeByUser.delete(userId);
    else activeByUser.set(userId, remaining);
    schedule();
  });
}

function enqueue(entry: QueueEntry): void {
  waiting.push(entry);
  schedule();
}

function idempotencyKey(userId: string, request: RunRequest): string {
  return createHash("sha256").update(JSON.stringify({
    userId,
    profileId: request.profile.id,
    profileUpdatedAt: request.profile.updatedAt,
    job: {
      url: request.job.url,
      title: request.job.title,
      company: request.job.company,
      description: request.job.description
    },
    pipelineVersion: PIPELINE_VERSION
  })).digest("hex");
}

function publicRun(run: StoredRun): TailoringRunStatus {
  return tailoringRunStatusSchema.parse({
    id: run.id,
    status: run.status,
    stage: run.stage,
    progress: run.progress,
    error: run.error,
    cv: run.cv,
    evaluation: run.evaluation,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  });
}

function rowToRun(row: Record<string, unknown>): StoredRun {
  const request = row.request
    ? {
      profile: baseProfileSchema.parse((row.request as RunRequest).profile),
      job: jobDescriptionSchema.parse((row.request as RunRequest).job)
    }
    : undefined;
  return {
    ...tailoringRunStatusSchema.parse({
      id: row.id,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      error: row.error,
      cv: row.result || undefined,
      evaluation: row.evaluation || undefined,
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString()
    }),
    userId: String(row.user_id),
    provider: row.provider as AiProvider,
    request,
    cancelRequested: Boolean(row.cancel_requested),
    usageEventId: row.usage_event_id ? String(row.usage_event_id) : undefined,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : undefined,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : undefined
  };
}

async function persist(run: StoredRun, testMode: boolean): Promise<void> {
  memoryRuns.set(run.id, run);
  if (testMode) return;
  await pool.query(
    `UPDATE tailoring_runs
       SET status=$2, stage=$3, progress=$4, result=$5, evaluation=$6,
           metadata=$7, error=$8, cancel_requested=$9, started_at=$10, finished_at=$11, updated_at=now()
     WHERE id=$1`,
    [
      run.id,
      run.status,
      run.stage,
      run.progress,
      run.cv ? JSON.stringify(run.cv) : null,
      run.evaluation ? JSON.stringify(run.evaluation) : null,
      run.cv?.pipeline ? JSON.stringify(run.cv.pipeline) : null,
      run.error,
      run.cancelRequested,
      run.startedAt || null,
      run.finishedAt || null
    ]
  );
}

async function loadRun(id: string, userId: string, testMode: boolean): Promise<StoredRun | null> {
  const inMemory = memoryRuns.get(id);
  if (inMemory?.userId === userId) return inMemory;
  if (testMode) return null;
  const { rows } = await pool.query("SELECT * FROM tailoring_runs WHERE id=$1 AND user_id=$2", [id, userId]);
  return rows[0] ? rowToRun(rows[0]) : null;
}

async function executeRun(
  run: StoredRun,
  testMode: boolean,
  generatorFactory?: () => Generator
): Promise<void> {
  if (activeRuns.has(run.id) || !run.request || run.cancelRequested) return;
  activeRuns.add(run.id);
  try {
    run.status = "running";
    run.stage = "planning";
    run.progress = 5;
    run.startedAt = new Date().toISOString();
    run.updatedAt = run.startedAt;
    await persist(run, testMode);
    const generator = generatorFactory ? generatorFactory() : createGenerator(run.provider);
    const provider = providerStatus(run.provider);
    const cv = await generateUnifiedCv({
      generator,
      profile: run.request.profile,
      job: run.request.job,
      runId: run.id,
      provider: run.provider,
      model: provider.model,
      onProgress: async (stage, progress) => {
        const latest = await loadRun(run.id, run.userId, testMode);
        if (latest?.cancelRequested) throw new Error("Tailoring cancelled");
        run.stage = stage as StoredRun["stage"];
        run.progress = progress;
        run.updatedAt = new Date().toISOString();
        await persist(run, testMode);
      }
    });
    run.status = "completed";
    run.stage = "completed";
    run.progress = 100;
    run.cv = cv;
    run.evaluation = cv.evaluation;
    run.request = undefined;
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    await persist(run, testMode);
    if (!testMode) await pool.query("UPDATE tailoring_runs SET request=NULL WHERE id=$1", [run.id]);
    const usageMeta = {
      pipelineVersion: cv.pipeline.pipelineVersion,
      provider: run.provider,
      aiCallCount: cv.pipeline.aiCallCount,
      repairCount: cv.pipeline.repairCount,
      stages: cv.pipeline.stages.map((stage) => ({ name: stage.name, durationMs: stage.durationMs, attempts: stage.attempts }))
    };
    if (!testMode && run.usageEventId) {
      await pool.query("UPDATE usage_events SET meta=$2 WHERE id=$1", [run.usageEventId, JSON.stringify(usageMeta)]);
    } else if (!testMode) {
      await recordUsage(run.userId, "tailor", usageMeta);
    }
  } catch (error) {
    const cancelled = run.cancelRequested || (error instanceof Error && error.message === "Tailoring cancelled");
    run.status = cancelled ? "cancelled" : "failed";
    run.error = cancelled ? "Tailoring cancelled" : error instanceof Error ? error.message : String(error);
    if (!cancelled) console.error(`Tailoring run ${run.id} failed:`, error);
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    await persist(run, testMode);
    if (!testMode && run.usageEventId) {
      await releaseUsage(run.usageEventId).catch(() => undefined);
      run.usageEventId = undefined;
      await pool.query("UPDATE tailoring_runs SET usage_event_id=NULL WHERE id=$1", [run.id]).catch(() => undefined);
    }
  } finally {
    activeRuns.delete(run.id);
  }
}

export async function createTailoringRun(input: {
  userId: string;
  provider: AiProvider;
  profile: BaseProfile;
  job: JobDescription;
  testMode: boolean;
  generatorFactory?: () => Generator;
  freeMonthlyLimit?: number;
}): Promise<TailoringRunStatus> {
  const request = { profile: input.profile, job: input.job };
  const key = idempotencyKey(input.userId, request);
  let run: StoredRun | null = null;
  // Only a freshly created run or one reset from failed/cancelled needs to be
  // (re-)scheduled; a run already queued/running/completed via idempotent
  // reuse must not be pushed onto the queue a second time.
  let needsSchedule = false;

  if (!input.testMode) {
    const { rows } = await pool.query(
      "SELECT * FROM tailoring_runs WHERE user_id=$1 AND idempotency_key=$2 AND pipeline_version=$3",
      [input.userId, key, PIPELINE_VERSION]
    );
    if (rows[0]) {
      run = rowToRun(rows[0]);
      if (["failed", "cancelled"].includes(run.status)) {
        needsSchedule = true;
        if ((input.freeMonthlyLimit || 0) > 0 && !run.usageEventId) {
          const reservation = await reserveTailor(input.userId, input.freeMonthlyLimit || 0);
          if (!reservation.ok) throw new Error("Monthly free limit reached. Upgrade to continue tailoring.");
          run.usageEventId = reservation.eventId;
        }
        run.request = request;
        run.provider = input.provider;
        run.cancelRequested = false;
        run.status = "queued";
        run.stage = "queued";
        run.progress = 0;
        run.error = "";
        run.cv = undefined;
        run.evaluation = undefined;
        await pool.query(
          `UPDATE tailoring_runs SET provider=$2,status='queued',stage='queued',progress=0,
             request=$3,result=NULL,evaluation=NULL,metadata=NULL,error='',cancel_requested=false,usage_event_id=$4,updated_at=now()
           WHERE id=$1`,
          [run.id, input.provider, JSON.stringify(request), run.usageEventId || null]
        );
      }
    }
  } else {
    run = [...memoryRuns.values()].find((candidate) =>
      candidate.userId === input.userId &&
      candidate.request &&
      idempotencyKey(candidate.userId, candidate.request) === key
    ) || null;
    if (run && ["failed", "cancelled"].includes(run.status)) {
      needsSchedule = true;
      Object.assign(run, {
        provider: input.provider,
        request,
        cancelRequested: false,
        status: "queued",
        stage: "queued",
        progress: 0,
        error: "",
        cv: undefined,
        evaluation: undefined
      });
    }
  }

  if (!run) {
    needsSchedule = true;
    const now = new Date().toISOString();
    run = {
      id: crypto.randomUUID(),
      userId: input.userId,
      provider: input.provider,
      request,
      cancelRequested: false,
      status: "queued",
      stage: "queued",
      progress: 0,
      error: "",
      createdAt: now,
      updatedAt: now
    };
    if (!input.testMode && (input.freeMonthlyLimit || 0) > 0) {
      const reservation = await reserveTailor(input.userId, input.freeMonthlyLimit || 0);
      if (!reservation.ok) throw new Error("Monthly free limit reached. Upgrade to continue tailoring.");
      run.usageEventId = reservation.eventId;
    }
    memoryRuns.set(run.id, run);
    if (!input.testMode) {
      try {
        await pool.query(
          `INSERT INTO tailoring_runs
            (id,user_id,idempotency_key,pipeline_version,provider,status,stage,progress,request,usage_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [run.id, run.userId, key, PIPELINE_VERSION, run.provider, run.status, run.stage, run.progress, JSON.stringify(request), run.usageEventId || null]
        );
      } catch (error) {
        if (run.usageEventId) await releaseUsage(run.usageEventId).catch(() => undefined);
        memoryRuns.delete(run.id);
        throw error;
      }
    }
  }
  if (needsSchedule) enqueue({ run, testMode: input.testMode, generatorFactory: input.generatorFactory });
  return publicRun(run);
}

export async function getTailoringRun(id: string, userId: string, testMode: boolean): Promise<TailoringRunStatus | null> {
  const run = await loadRun(id, userId, testMode);
  return run ? publicRun(run) : null;
}

export async function cancelTailoringRun(id: string, userId: string, testMode: boolean): Promise<TailoringRunStatus | null> {
  const run = await loadRun(id, userId, testMode);
  if (!run) return null;
  run.cancelRequested = true;
  if (run.status === "queued") {
    run.status = "cancelled";
    run.error = "Tailoring cancelled";
    if (!testMode && run.usageEventId) {
      await releaseUsage(run.usageEventId).catch(() => undefined);
      run.usageEventId = undefined;
      await pool.query("UPDATE tailoring_runs SET usage_event_id=NULL WHERE id=$1", [run.id]).catch(() => undefined);
    }
  }
  await persist(run, testMode);
  return publicRun(run);
}

export async function recoverTailoringRuns(): Promise<void> {
  await pool.query(
    `UPDATE tailoring_runs SET request=NULL
       WHERE status IN ('completed','failed','cancelled')
         AND updated_at < now() - interval '24 hours'`
  );
  const { rows } = await pool.query(
    "SELECT * FROM tailoring_runs WHERE status IN ('queued','running') AND request IS NOT NULL ORDER BY created_at"
  );
  for (const row of rows) {
    const run = rowToRun(row);
    run.status = "queued";
    run.stage = "queued";
    run.progress = 0;
    run.error = "";
    run.cancelRequested = false;
    memoryRuns.set(run.id, run);
    enqueue({ run, testMode: false });
  }
}
