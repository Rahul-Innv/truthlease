/**
 * App-wide singletons for the Next.js server: one store (file-backed SQLite,
 * cached on globalThis), one service, one background job runner registry.
 *
 * Environment: CLEARING_DB_PATH (default .data/clearing.sqlite),
 * CLEARING_PACE_MS (default 350), CLEARING_REASONING + ANTHROPIC_API_KEY for
 * the feature-flagged live provider (local rules otherwise), MOSS_PROJECT_ID +
 * MOSS_PROJECT_KEY for Moss supplier discovery (local keyword matcher otherwise),
 * BAND_BUYER_AGENT_ID + BAND_BUYER_API_KEY + BAND_SELLER_AGENTS for BAND-room coordination.
 */
import { CATALOG } from "./catalog";
import type { Run } from "./contracts";
import { bandCoordinatorFromEnv } from "./coordination/band";
import { localCoordinator } from "./coordination/local";
import { localDiscovery } from "./discovery/local";
import { createMossClient, mossProvider } from "./discovery/moss";
import { tavilyWebDiscovery, withWebDiscovery } from "./discovery/tavily";
import type { DiscoveryProvider } from "./discovery/types";
import { systemClock } from "./fixtures";
import { ensureJobRunning, startJobRunner } from "./jobs";
import { liveProvider, liveProviderFromEnv } from "./providers/live";
import { zooworkTransportFromEnv } from "./providers/zoowork";
import { localProvider } from "./providers/local";
import { integrationStatus } from "./providers/status";
import type { ReasoningProvider } from "./providers/types";
import { createService, type Service, type ServiceDeps } from "./service";
import { advanceOnRead, isServerless, runRequestCycle } from "./serverless";
import { getAppStore } from "./store";
import type { HydrateOptions, SqlLike, SupabaseStore } from "./store-supabase";

export { isServerless };

async function appProvider(): Promise<ReasoningProvider> {
  try {
    const zoowork = await zooworkTransportFromEnv(process.env);
    if (zoowork) {
      const timeoutMs = Number(process.env.CLEARING_MODEL_TIMEOUT_MS ?? 60_000) || 60_000;
      return liveProvider({
        transport: zoowork,
        maxCalls: Number(process.env.CLEARING_MAX_MODEL_CALLS ?? 16) || 16,
        maxConcurrent: Number(process.env.CLEARING_MAX_CONCURRENT_MODEL_CALLS ?? 4) || 4,
        timeoutMs,
      });
    }
    return (await liveProviderFromEnv(process.env)) ?? localProvider();
  } catch (err) {
    console.error("[clearing] live provider unavailable; using local rules:", err instanceof Error ? err.message : String(err));
    return localProvider();
  }
}

/**
 * Supplier discovery: Moss when both credentials are present, else the local keyword
 * matcher. Either way the results are unverified candidates, never executable offers.
 */
export function appDiscovery(env: Readonly<Record<string, string | undefined>> = process.env): DiscoveryProvider {
  const id = env.MOSS_PROJECT_ID;
  const key = env.MOSS_PROJECT_KEY;
  let base: DiscoveryProvider;
  if (!id || !key) base = localDiscovery();
  else {
    const moss = mossProvider({ client: () => createMossClient(id, key), recordProcessStatus: true });
    void moss.warm(); // build/load the index in the background so the first run is not slow
    base = moss;
  }
  // Optional web discovery: results are appended as unverified, never-executable candidates.
  return env.TAVILY_API_KEY ? withWebDiscovery(base, tavilyWebDiscovery({ apiKey: env.TAVILY_API_KEY })) : base;
}

let servicePromise: Promise<Service> | null = null;

/** The process-wide service. Commands that start a job also start the background runner. */
export function getService(): Promise<Service> {
  if (isServerless()) return Promise.reject(new Error("getService() is not available with CLEARING_STORE=supabase; use withService()."));
  if (!servicePromise) {
    servicePromise = appProvider().then((provider) => {
      const service: Service = createService({
        store: getAppStore(),
        clock: systemClock(),
        provider,
        paceMs: integrationStatus().paceMs,
        // BAND room when BAND_BUYER_AGENT_ID + BAND_BUYER_API_KEY are set; in-process sellers otherwise.
        coordinator: bandCoordinatorFromEnv(process.env, CATALOG) ?? localCoordinator(CATALOG),
        discovery: appDiscovery(),
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

// ---------------------------------------------------------------------------
// Serverless server mode (CLEARING_STORE=supabase + SUPABASE_DB_URL): no process
// singleton service and no background runner. Each request hydrates a fresh
// snapshot from Supabase Postgres, runs, and flushes (see lib/serverless.ts).
// ---------------------------------------------------------------------------

type PgSql = import("postgres").Sql;
type PgTx = import("postgres").TransactionSql;

/** Adapt postgres.js to the store's SqlLike (text + positional params; one transaction per flush). */
export function postgresSqlLike(sql: PgSql): SqlLike {
  const inTx = (tx: PgTx): SqlLike => ({
    query: async (text, params = []) => [...(await tx.unsafe(text, params as never[]))],
    transaction: (fn) => fn(inTx(tx)),
  });
  return {
    query: async (text, params = []) => [...(await sql.unsafe(text, params as never[]))],
    transaction: <T>(fn: (tx: SqlLike) => Promise<T>) => sql.begin((tx) => fn(inTx(tx))) as Promise<T>,
  };
}

let serverlessSql: Promise<SqlLike> | null = null;

/** One small module-level client: `prepare: false` and `max: 1`, as Supabase's transaction pooler requires. Lazy, so builds never connect. */
function supabaseSql(): Promise<SqlLike> {
  if (!serverlessSql) {
    serverlessSql = import("postgres").then(({ default: postgres }) =>
      postgresSqlLike(postgres(String(process.env.SUPABASE_DB_URL), { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 })),
    );
  }
  return serverlessSql;
}

let serverlessDeps: Promise<Omit<ServiceDeps, "store" | "clock">> | null = null;

function serverlessServiceDeps(): Promise<Omit<ServiceDeps, "store" | "clock">> {
  if (!serverlessDeps) {
    serverlessDeps = appProvider().then((provider) => ({
      provider,
      paceMs: integrationStatus().paceMs,
      coordinator: bandCoordinatorFromEnv(process.env, CATALOG) ?? localCoordinator(CATALOG),
      discovery: appDiscovery(),
      scheduleJob: () => {}, // no background work on serverless: jobs advance on read
    }));
  }
  return serverlessDeps;
}

/** Supabase mode: hydrate → build a service → run `fn` → flush; a VersionConflict re-hydrates and runs `fn` once more. */
export async function withRequestService<T>(fn: (service: Service, store: SupabaseStore) => Promise<T>, opts: HydrateOptions = {}): Promise<T> {
  const [sql, deps] = await Promise.all([supabaseSql(), serverlessServiceDeps()]);
  return runRequestCycle(sql, (store) => createService({ ...deps, store, clock: systemClock() }), fn, opts);
}

/** Run `fn` with the right service for this deployment: the per-request Supabase service, or the SQLite singleton. */
export async function withService<T>(fn: (service: Service) => Promise<T>, opts: HydrateOptions = {}): Promise<T> {
  if (isServerless()) return withRequestService((service) => fn(service), opts);
  return fn(await getService());
}

/**
 * Keep a pending job moving when a client reads the run. SQLite: re-arm the in-process
 * runner. Supabase: work on read, up to 3 pipeline steps within 2 s, before responding.
 */
export async function progressOnRead(service: Service, run: Run): Promise<Run> {
  if (!isServerless()) {
    rearmJob(service, run);
    return run;
  }
  if (!run.job) return run;
  return (await advanceOnRead(service, run.id, { maxSteps: 3, budgetMs: 2000 })) ?? run;
}
