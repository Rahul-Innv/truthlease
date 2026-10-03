/**
 * Serverless server mode (CLEARING_STORE=supabase): per-request hydrate → run →
 * flush, and "work on read" pipeline progress. No background work: a job only
 * advances while a client reads the run (GET /api/runs/current or the events page).
 *
 * Kept free of Next.js and postgres imports so tests drive it with a fake SqlLike.
 */
import { StaleJob, type Service } from "./service";
import { NotFound, VersionConflict } from "./store";
import { createSupabaseStore, type HydrateOptions, type SqlLike, type SupabaseStore } from "./store-supabase";
import type { Run } from "./contracts";

/** True when the app runs the Supabase-backed serverless store (no process singleton, no background runner). */
export function isServerless(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.CLEARING_STORE === "supabase" && Boolean(env.SUPABASE_DB_URL);
}

/**
 * One request cycle: hydrate a fresh snapshot, build a service over it, run `fn`, flush.
 * A VersionConflict (from the flush or the service) re-hydrates and runs `fn` once more.
 * Writes that `fn` committed before throwing are still flushed (SQLite parity: a commit is durable).
 */
export async function runRequestCycle<T>(
  sql: SqlLike,
  buildService: (store: SupabaseStore) => Service,
  fn: (service: Service, store: SupabaseStore) => Promise<T>,
  opts: HydrateOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const store = createSupabaseStore({ sql });
      await store.hydrate(opts);
      const service = buildService(store);
      let result: T | undefined;
      let failure: unknown = null;
      try {
        result = await fn(service, store);
      } catch (err) {
        failure = err ?? new Error("Request failed.");
      }
      await store.flush();
      if (failure) throw failure;
      return result as T;
    } catch (err) {
      if (err instanceof VersionConflict && attempt === 0) continue;
      throw err;
    }
  }
}

export interface AdvanceOnReadOptions {
  /** Pipeline steps per read (default 3). */
  maxSteps?: number;
  /** Wall-time budget per read in ms (default 2000). */
  budgetMs?: number;
}

/**
 * Work on read: advance the run's pending job by up to `maxSteps` steps within `budgetMs`.
 * Mirrors the background runner's error handling (stale job ⇒ stop; other errors ⇒ job.failed).
 */
export async function advanceOnRead(service: Service, runId: string, opts: AdvanceOnReadOptions = {}): Promise<Run | null> {
  const maxSteps = opts.maxSteps ?? 3;
  const budgetMs = opts.budgetMs ?? 2000;
  const started = Date.now();
  let run = service.getRun(runId);
  for (let i = 0; i < maxSteps && run?.job; i++) {
    if (i > 0 && Date.now() - started >= budgetMs) break;
    try {
      const r = await service.advance(runId);
      run = r.run;
      if (r.done) break;
    } catch (err) {
      if (err instanceof StaleJob) return service.getRun(runId);
      if (err instanceof NotFound) return null;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[clearing] work-on-read step for ${runId} failed:`, reason);
      return service.failJob(runId, undefined, reason) ?? service.getRun(runId);
    }
  }
  return run;
}
