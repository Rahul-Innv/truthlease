/**
 * In-process background runner for pipeline jobs.
 *
 * One runner per run id, registered on globalThis so dev HMR never starts a
 * duplicate. The runner loops `service.drain()` (which calls `advance()` and
 * sleeps `paceMs` only after supplier events) until the run has no job. A
 * kick that arrives while a runner is active is remembered and re-checked
 * before the runner exits, so a job created at the tail of a loop is never
 * dropped. Every step reads and writes the store, so a restarted process
 * resumes from stored state when `ensureJobRunning` re-arms it.
 */
import { NotFound } from "./store";
import type { Run } from "./contracts";
import type { Service } from "./service";

type JobService = Pick<Service, "drain" | "failJob">;

interface RunnerEntry {
  kicked: boolean;
  done: Promise<void>;
}

function registry(): Map<string, RunnerEntry> {
  const g = globalThis as typeof globalThis & { __clearingJobs?: Map<string, RunnerEntry> };
  if (!g.__clearingJobs) g.__clearingJobs = new Map();
  return g.__clearingJobs;
}

export function isJobRunning(runId: string): boolean {
  return registry().has(runId);
}

/** Start (or re-kick) the background runner for a run. Returns immediately. */
export function startJobRunner(service: JobService, runId: string): void {
  const reg = registry();
  const existing = reg.get(runId);
  if (existing) {
    existing.kicked = true;
    return;
  }
  const entry: RunnerEntry = { kicked: true, done: Promise.resolve() };
  reg.set(runId, entry);
  entry.done = (async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      while (entry.kicked) {
        entry.kicked = false;
        await service.drain(runId);
      }
    } catch (err) {
      if (!(err instanceof NotFound)) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[clearing] job runner for ${runId} failed:`, reason);
        service.failJob(runId, undefined, reason);
      }
    } finally {
      reg.delete(runId);
    }
  })();
}

/** Re-arm a job left in the store with no in-process runner (e.g. after a restart). */
export function ensureJobRunning(service: JobService, run: Run): void {
  if (run.job && !isJobRunning(run.id)) startJobRunner(service, run.id);
}

/** Resolves when the run's runner (if any) has finished. Diagnostics and scripts only. */
export async function waitForRunner(runId: string): Promise<void> {
  await registry().get(runId)?.done;
}
