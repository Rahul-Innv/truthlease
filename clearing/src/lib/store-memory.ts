/**
 * In-memory Store (browser runtime and tests), optionally persisted as one
 * JSON document through a caller-supplied `persist` adapter (localStorage in
 * the browser runtime).
 *
 * Semantics match the SQLite store in `store.ts` exactly:
 * - `commit` is a compare-and-swap on `version` (VersionConflict on mismatch,
 *   NotFound for an unknown run), refuses a stored idempotency key with
 *   IdempotencyReplay, assigns contiguous per-run event seqs, validates the
 *   run and every event with the contract schemas, and writes nothing at all
 *   when any check fails (all validation happens before the first write).
 * - Runs and idempotent responses are stored serialized and parsed on read,
 *   so callers never share object references with the store.
 *
 * This module has no Node-only imports. It imports the typed errors from
 * `store.ts` so `instanceof` checks in the service match either store.
 */
import { AttendeeResponse, Run, RunEvent } from "./contracts";
import { IdempotencyReplay, NotFound, VersionConflict, type NewEvent, type Store, type StoredResponse } from "./store";

export interface PersistAdapter {
  load(): string | null;
  save(json: string): void;
}

export interface MemoryStoreOptions {
  persist?: PersistAdapter;
  /** Debounce for `persist.save` after a write (default 100 ms; 0 saves synchronously). */
  persistDelayMs?: number;
  /** Called synchronously after every successful write (commit, insert, delete, meta, attendee rows). */
  onWrite?: () => void;
}

export interface MemoryStore extends Store {
  /** Write any pending state to `persist` now (no-op without an adapter). */
  flush(): void;
  /** The serialized document `flush` would save. */
  serialize(): string;
}

/** Version of the persisted document shape. */
export const MEMORY_STORE_FORMAT = 1;

interface RunRow {
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Run JSON, as SQLite stores it. */
  state: string;
}

interface PersistedDoc {
  format: number;
  runs: Record<string, RunRow>;
  events: Record<string, RunEvent[]>;
  idempotency: Record<string, Record<string, string>>;
  meta: Record<string, string>;
  attendeeLinks: Record<string, string>;
  attendeeResponses: Record<string, AttendeeResponse[]>;
}

const clone = <T>(x: T): T => structuredClone(x);

function buildEvents(runId: string, startSeq: number, events: NewEvent[]): RunEvent[] {
  let seq = startSeq;
  return events.map((e) => {
    seq += 1;
    const ev = RunEvent.parse({
      id: `evt_${runId}_${seq}`,
      runId,
      seq,
      type: e.type,
      at: e.at,
      ...(e.causeId ? { causeId: e.causeId } : {}),
      summary: e.summary.slice(0, 200),
      payload: e.payload,
    });
    // Same JSON round trip the SQLite payload column applies.
    return JSON.parse(JSON.stringify(ev)) as RunEvent;
  });
}

function byResponseOrder(a: AttendeeResponse, b: AttendeeResponse): number {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  return a.respondentId < b.respondentId ? -1 : a.respondentId > b.respondentId ? 1 : 0;
}

export function memoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  const runs = new Map<string, RunRow>();
  const events = new Map<string, RunEvent[]>();
  const idempotency = new Map<string, Map<string, string>>();
  const meta = new Map<string, string>();
  const attendeeLinks = new Map<string, string>();
  const attendeeResponses = new Map<string, Map<string, AttendeeResponse>>();

  const delay = opts.persistDelayMs ?? 100;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  function serialize(): string {
    const doc: PersistedDoc = {
      format: MEMORY_STORE_FORMAT,
      runs: Object.fromEntries(runs),
      events: Object.fromEntries(events),
      idempotency: Object.fromEntries([...idempotency].map(([runId, m]) => [runId, Object.fromEntries(m)])),
      meta: Object.fromEntries(meta),
      attendeeLinks: Object.fromEntries(attendeeLinks),
      attendeeResponses: Object.fromEntries([...attendeeResponses].map(([runId, m]) => [runId, [...m.values()]])),
    };
    return JSON.stringify(doc);
  }

  function flush(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty || !opts.persist) return;
    dirty = false;
    try {
      opts.persist.save(serialize());
    } catch (err) {
      // Quota exceeded or storage blocked: state stays in memory for this page.
      console.warn("[clearing] could not persist browser state:", err instanceof Error ? err.message : String(err));
    }
  }

  function written(): void {
    if (opts.persist) {
      dirty = true;
      if (delay <= 0) flush();
      else if (!saveTimer) saveTimer = setTimeout(flush, delay);
    }
    opts.onWrite?.();
  }

  /** Load a persisted document; anything that fails validation is dropped, never trusted. */
  function hydrate(raw: string | null): void {
    if (!raw) return;
    let doc: Partial<PersistedDoc>;
    try {
      doc = JSON.parse(raw) as Partial<PersistedDoc>;
    } catch {
      return;
    }
    if (!doc || typeof doc !== "object" || doc.format !== MEMORY_STORE_FORMAT) return;
    for (const [id, row] of Object.entries(doc.runs ?? {})) {
      try {
        if (!row || typeof row !== "object" || typeof row.state !== "string") continue;
        const run = Run.parse(JSON.parse(row.state));
        if (run.id !== id || run.version !== row.version) continue;
        const evs = (doc.events?.[id] ?? []).map((e) => RunEvent.parse(e));
        // Seqs must be the contiguous 1..lastSeq the run expects; otherwise the run is corrupt.
        if (evs.length !== run.lastSeq || evs.some((e, i) => e.seq !== i + 1 || e.runId !== id)) continue;
        runs.set(id, { version: run.version, createdAt: String(row.createdAt ?? run.createdAt), updatedAt: String(row.updatedAt ?? run.updatedAt), state: JSON.stringify(run) });
        events.set(id, evs);
        const idem = new Map<string, string>();
        for (const [key, response] of Object.entries(doc.idempotency?.[id] ?? {})) {
          if (typeof response !== "string") continue;
          const parsed = JSON.parse(response) as StoredResponse;
          if (parsed && typeof parsed.status === "number") idem.set(key, response);
        }
        if (idem.size) idempotency.set(id, idem);
        const resp = new Map<string, AttendeeResponse>();
        for (const r of doc.attendeeResponses?.[id] ?? []) {
          const ok = AttendeeResponse.safeParse(r);
          if (ok.success) resp.set(ok.data.respondentId, ok.data);
        }
        if (resp.size) attendeeResponses.set(id, resp);
      } catch {
        // A corrupt run is dropped with its events and idempotency records.
        runs.delete(id);
        events.delete(id);
        idempotency.delete(id);
        attendeeResponses.delete(id);
      }
    }
    for (const [k, v] of Object.entries(doc.meta ?? {})) if (typeof v === "string") meta.set(k, v);
    const current = meta.get("current_run_id");
    if (current && !runs.has(current)) meta.delete("current_run_id");
    for (const [token, runId] of Object.entries(doc.attendeeLinks ?? {})) {
      if (typeof runId === "string" && runs.has(runId)) attendeeLinks.set(token, runId);
    }
  }

  if (opts.persist) {
    try {
      hydrate(opts.persist.load());
    } catch {
      // Unreadable storage: start empty.
    }
  }

  // -------------------------------------------------------------------------
  // Store API
  // -------------------------------------------------------------------------

  return {
    getRun(id) {
      const row = runs.get(id);
      return row ? Run.parse(JSON.parse(row.state)) : null;
    },

    getCurrentRunId() {
      return meta.get("current_run_id") ?? null;
    },

    setCurrentRunId(id) {
      meta.set("current_run_id", id);
      written();
    },

    listEvents(runId, afterSeq = 0, limit = 1000) {
      const list = events.get(runId) ?? [];
      const out: RunEvent[] = [];
      for (const e of list) {
        if (e.seq <= afterSeq) continue;
        if (out.length >= limit) break;
        out.push(clone(e));
      }
      return out;
    },

    listEventsByCause(runId, causeId) {
      return (events.get(runId) ?? []).filter((e) => e.causeId === causeId).map(clone);
    },

    getIdempotent(runId, key) {
      const raw = idempotency.get(runId)?.get(key);
      return raw ? (JSON.parse(raw) as StoredResponse) : null;
    },

    commit({ run, expectedVersion, events: newEvents, idempotent }) {
      const cur = runs.get(run.id);
      if (!cur) throw new NotFound(`Run ${run.id} not found.`);
      if (cur.version !== expectedVersion) {
        throw new VersionConflict(undefined, { expectedVersion, actualVersion: cur.version });
      }
      if (idempotent) {
        const existing = idempotency.get(run.id)?.get(idempotent.key);
        if (existing) throw new IdempotencyReplay(JSON.parse(existing) as StoredResponse);
      }
      const list = events.get(run.id) ?? [];
      const maxSeq = list.length ? list[list.length - 1]!.seq : 0;
      // Validate everything before the first write so a failure leaves the store untouched.
      const next = Run.parse({ ...run, version: expectedVersion + 1, lastSeq: maxSeq + newEvents.length });
      const built = buildEvents(run.id, maxSeq, newEvents);
      let response: string | null = null;
      if (idempotent) {
        const body = typeof idempotent.body === "function" ? (idempotent.body as (r: Run) => unknown)(next) : (idempotent.body ?? { run: next });
        const stored: StoredResponse = { status: idempotent.status ?? 200, body };
        response = JSON.stringify(stored);
      }
      const state = JSON.stringify(next);

      runs.set(run.id, { version: next.version, createdAt: cur.createdAt, updatedAt: next.updatedAt, state });
      events.set(run.id, list.concat(built));
      if (idempotent && response !== null) {
        let m = idempotency.get(run.id);
        if (!m) {
          m = new Map();
          idempotency.set(run.id, m);
        }
        m.set(idempotent.key, response);
      }
      written();
      return Run.parse(JSON.parse(state));
    },

    insertRun(run, newEvents = []) {
      if (runs.has(run.id)) throw new Error(`Run ${run.id} already exists.`);
      const next = Run.parse({ ...run, lastSeq: newEvents.length });
      const built = buildEvents(next.id, 0, newEvents);
      const state = JSON.stringify(next);
      runs.set(next.id, { version: next.version, createdAt: next.createdAt, updatedAt: next.updatedAt, state });
      events.set(next.id, built);
      written();
      return Run.parse(JSON.parse(state));
    },

    deleteAll() {
      runs.clear();
      events.clear();
      idempotency.clear();
      meta.clear();
      attendeeLinks.clear();
      attendeeResponses.clear();
      written();
    },

    close() {
      flush();
    },

    putAttendeeLink(token, runId) {
      if (attendeeLinks.has(token)) throw new Error("Attendee link token already exists.");
      attendeeLinks.set(token, runId);
      written();
    },

    findRunIdByAttendeeToken(token) {
      return attendeeLinks.get(token) ?? null;
    },

    upsertAttendeeResponse(runId, response) {
      const r = AttendeeResponse.parse(response);
      let m = attendeeResponses.get(runId);
      if (!m) {
        m = new Map();
        attendeeResponses.set(runId, m);
      }
      m.set(r.respondentId, { respondentId: r.respondentId, preference: r.preference, partySize: r.partySize, submittedAt: r.submittedAt });
      written();
    },

    listAttendeeResponses(runId) {
      return [...(attendeeResponses.get(runId)?.values() ?? [])].sort(byResponseOrder).map((r) => AttendeeResponse.parse(clone(r)));
    },

    flush,
    serialize,
  };
}
