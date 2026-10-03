/**
 * App-wide singletons for the Next.js server: one store (file-backed SQLite,
 * cached on globalThis), one service, one background job runner registry.
 *
 * Environment: CLEARING_DB_PATH (default .data/clearing.sqlite),
 * CLEARING_PACE_MS (default 350), CLEARING_REASONING + ANTHROPIC_API_KEY for
 * the feature-flagged live provider (local rules otherwise).
 */
import type { Run } from "./contracts";
import { systemClock } from "./fixtures";
import { ensureJobRunning, startJobRunner } from "./jobs";
import { liveProviderFromEnv } from "./providers/live";
import { localProvider } from "./providers/local";
import { integrationStatus } from "./providers/status";
import type { ReasoningProvider } from "./providers/types";
import { createService, type Service } from "./service";
import { getAppStore } from "./store";

async function appProvider(): Promise<ReasoningProvider> {
  try {
    return (await liveProviderFromEnv(process.env)) ?? localProvider();
  } catch (err) {
    console.error("[clearing] live provider unavailable; using local rules:", err instanceof Error ? err.message : String(err));
    return localProvider();
  }
}

let servicePromise: Promise<Service> | null = null;

/** The process-wide service. Commands that start a job also start the background runner. */
export function getService(): Promise<Service> {
  if (!servicePromise) {
    servicePromise = appProvider().then((provider) => {
      const service: Service = createService({
        store: getAppStore(),
        clock: systemClock(),
        provider,
        paceMs: integrationStatus().paceMs,
        scheduleJob: (runId) => startJobRunner(service, runId),
      });
      return service;
    });
  }
  return servicePromise;
}

/** Re-arm a stored job that has no in-process runner (process restart or HMR). */
export function rearmJob(service: Service, run: Run): void {
  ensureJobRunning(service, run);
}
