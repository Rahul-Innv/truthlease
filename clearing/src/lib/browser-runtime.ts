/**
 * Browser runtime (labelled demo mode, NEXT_PUBLIC_CLEARING_RUNTIME=browser).
 *
 * The same service, solver, seller and buyer code the server runs, executed in
 * the page against an in-memory store persisted to localStorage on this
 * device. Pipeline jobs run with the same runner as the server (`jobs.ts`,
 * setTimeout pacing), and an unfinished job is re-armed when the page loads,
 * so a refresh mid-pipeline resumes from stored state.
 *
 * What this mode is not: there is no server, no shared state, no agent API and
 * no attendee links. Seller policies ship inside the page bundle here, so they
 * are not kept server-side in this mode (the UI says so).
 *
 * Client-only: import it dynamically from "use client" code.
 */
import { AttendeeLinkCommand, AttendeeApplyCommand } from "./attendee";
// The private demo catalog (seller policies) necessarily ships in this mode; this is the only client-side import of it.
import { CATALOG } from "./catalog";
import {
  ApproveCommand,
  DisruptCommand,
  SettleRefundCommand,
  UpdateBudgetCommand,
  type IntegrationStatus,
  type Run,
  type RunEvent,
} from "./contracts";
import { systemClock } from "./fixtures";
import { ensureJobRunning, startJobRunner } from "./jobs";
import { localProvider } from "./providers/local";
import { ConfirmCommand, createService, parseOrThrow, ServiceError, SubmitRequestCommand, type Service } from "./service";
import { memoryStore, type MemoryStore, type PersistAdapter } from "./store-memory";

export const BROWSER_STORAGE_KEY = "clearing:runtime:v1";

/** Pacing between supplier events (readability only, as on the server). */
export const BROWSER_PACE_MS = 350;

/**
 * The status the browser runtime reports (same IntegrationStatus contract):
 * local rules, the fictional catalog, local transport, simulated orders, and
 * no integration connected — none can be, because no credential ever reaches
 * the browser. Kept here, not in providers/status.ts, so the page bundle never
 * pulls in server-side adapters.
 */
export function browserIntegrationStatus(): IntegrationStatus {
  return {
    reasoning: { mode: "local", provider: "Local rules", verified: true },
    supply: "Fictional demo catalog",
    coordination: "Local transport",
    execution: "Simulated orders",
    tavily: { connected: false, note: "Not connected — browser runtime (no server, no credentials)" },
    zoowork: { connected: false, note: "Not connected — browser runtime (no server, no credentials)" },
    band: { connected: false, note: "Not connected — browser runtime (no server, no credentials)" },
    paceMs: BROWSER_PACE_MS,
  };
}

/** Thrown for commands that need the server (attendee links, agent API). */
export class ServerModeOnly extends ServiceError {
  constructor(what: string) {
    super(501, "server_mode_only", `${what} needs the server mode; the browser runtime keeps state on this device only.`);
  }
}

export type RuntimeListener = (snapshot: Run, newEvents: RunEvent[]) => void;

export interface BrowserRuntime {
  readonly mode: "browser";
  readonly paceMs: number;
  status(): IntegrationStatus;
  getOrCreateCurrent(): Promise<Run>;
  listEvents(after?: number, limit?: number): RunEvent[];
  submitRequest(body: unknown): Promise<Run>;
  confirmRequirements(body?: unknown): Promise<Run>;
  approve(body: unknown): Promise<Run>;
  disrupt(body: unknown): Promise<Run>;
  settleRefund(body: unknown): Promise<Run>;
  updateBudget(body: unknown): Promise<Run>;
  reset(): Promise<Run>;
  createAttendeeLink(body?: unknown): Promise<Run>;
  applyAttendeeCounts(body?: unknown): Promise<Run>;
  /**
   * Called with the current run and the events this listener has not seen yet
   * (all events of the run on the first call, and again from seq 1 after a
   * reset). Fires once shortly after subscribing, then after every write.
   */
  subscribe(listener: RuntimeListener): () => void;
  /** Persist pending writes now (also done on pagehide). */
  flush(): void;
}

export interface BrowserRuntimeOptions {
  /** Defaults to window.localStorage under BROWSER_STORAGE_KEY (no-op when unavailable). */
  persist?: PersistAdapter;
  paceMs?: number;
}

function localStoragePersist(): PersistAdapter {
  return {
    load() {
      try {
        return globalThis.localStorage?.getItem(BROWSER_STORAGE_KEY) ?? null;
      } catch {
        return null; // private window or blocked storage
      }
    },
    save(json) {
      try {
        globalThis.localStorage?.setItem(BROWSER_STORAGE_KEY, json);
      } catch (err) {
        console.warn("[clearing] localStorage unavailable; state lives in this page only:", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createBrowserRuntime(opts: BrowserRuntimeOptions = {}): BrowserRuntime {
  interface Sub {
    fn: RuntimeListener;
    runId: string | null;
    lastSeq: number;
  }
  const subs = new Set<Sub>();
  let notifyQueued = false;

  const store: MemoryStore = memoryStore({ persist: opts.persist ?? localStoragePersist(), onWrite: () => queueNotify() });
  const paceMs = opts.paceMs ?? BROWSER_PACE_MS;
  const service: Service = createService({
    store,
    clock: systemClock(),
    provider: localProvider(),
    catalog: CATALOG,
    paceMs,
    scheduleJob: (runId) => startJobRunner(service, runId),
  });

  function deliver(sub: Sub, run: Run): void {
    if (sub.runId !== run.id) {
      // First delivery, or the demo was reset: replay the run from the start.
      sub.runId = run.id;
      sub.lastSeq = 0;
    }
    const fresh = service.listEvents(run.id, sub.lastSeq, 10_000);
    if (fresh.length) sub.lastSeq = fresh[fresh.length - 1]!.seq;
    try {
      sub.fn(run, fresh);
    } catch (err) {
      console.error("[clearing] runtime listener failed:", err);
    }
  }

  function notifyAll(): void {
    notifyQueued = false;
    const id = service.currentRunId();
    const run = id ? service.getRun(id) : null;
    if (!run) return;
    for (const sub of subs) deliver(sub, run);
  }

  /** Coalesce the writes of one command or pipeline step into one notification. */
  function queueNotify(): void {
    if (notifyQueued || subs.size === 0) return;
    notifyQueued = true;
    queueMicrotask(notifyAll);
  }

  async function current(): Promise<Run> {
    const run = await service.getOrCreateCurrent();
    ensureJobRunning(service, run);
    return run;
  }

  async function onCurrent(fn: (runId: string) => Promise<Run>): Promise<Run> {
    const run = await current();
    return fn(run.id);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => store.flush());
    window.addEventListener("beforeunload", () => store.flush());
  }

  // Re-arm a job left unfinished by a refresh or a closed tab.
  void current().catch((err) => console.error("[clearing] browser runtime could not load the current run:", err));

  return {
    mode: "browser",
    paceMs,
    status: browserIntegrationStatus,
    getOrCreateCurrent: current,
    listEvents(after = 0, limit = 10_000) {
      const id = service.currentRunId();
      return id ? service.listEvents(id, after, limit) : [];
    },
    submitRequest: (body) => onCurrent((id) => service.submitRequest(id, parseOrThrow(SubmitRequestCommand, body))),
    confirmRequirements: (body = {}) => onCurrent((id) => service.confirmRequirements(id, parseOrThrow(ConfirmCommand, body))),
    approve: (body) => onCurrent((id) => service.approve(id, parseOrThrow(ApproveCommand, body))),
    disrupt: (body) => onCurrent((id) => service.disrupt(id, parseOrThrow(DisruptCommand, body))),
    settleRefund: (body) => onCurrent((id) => service.settleRefund(id, parseOrThrow(SettleRefundCommand, body))),
    updateBudget: (body) => onCurrent((id) => service.updateBudget(id, parseOrThrow(UpdateBudgetCommand, body))),
    async reset() {
      const run = await service.reset();
      store.flush();
      return run;
    },
    async createAttendeeLink(body = {}) {
      parseOrThrow(AttendeeLinkCommand, body);
      throw new ServerModeOnly("Attendee links");
    },
    async applyAttendeeCounts(body = {}) {
      parseOrThrow(AttendeeApplyCommand, body);
      throw new ServerModeOnly("Applying attendee counts");
    },
    subscribe(fn) {
      const sub: Sub = { fn, runId: null, lastSeq: 0 };
      subs.add(sub);
      void current()
        .then((run) => {
          if (subs.has(sub) && sub.runId === null) deliver(sub, service.getRun(run.id) ?? run);
        })
        .catch((err) => console.error("[clearing] browser runtime could not load the current run:", err));
      return () => {
        subs.delete(sub);
      };
    },
    flush: () => store.flush(),
  };
}

/** One runtime per page, cached on globalThis so dev HMR never starts a second job runner. */
export function getBrowserRuntime(): BrowserRuntime {
  const g = globalThis as typeof globalThis & { __clearingBrowserRuntime?: BrowserRuntime };
  if (!g.__clearingBrowserRuntime) g.__clearingBrowserRuntime = createBrowserRuntime();
  return g.__clearingBrowserRuntime;
}
