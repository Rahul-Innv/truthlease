/**
 * Supabase Postgres store for the serverless (Vercel) server mode.
 *
 * The service is synchronous over `Store`, so this store is a HYDRATED
 * SNAPSHOT: `await hydrate()` loads one run (the current run, an explicit run
 * id, or the run behind an attendee token) with its events, idempotency
 * records and attendee rows into memory. Every `Store` method then works on
 * that snapshot with the same semantics as the SQLite store (CAS on version
 * with VersionConflict, IdempotencyReplay, contiguous per-run seqs, Zod
 * validation). `await flush()` writes the delta in ONE transaction:
 *
 * - runs: `UPDATE ... WHERE id = $id AND version = $versionAtHydrate`
 *   (0 rows ⇒ VersionConflict, so the caller re-hydrates and retries once);
 *   runs created in this snapshot are INSERTed;
 * - events with seq above the hydrated count; idempotency rows
 *   (ON CONFLICT DO NOTHING); attendee links and response upserts;
 * - meta `current_run_id` (compare-and-swap against the hydrated value);
 * - `deleteAll()` (demo reset) deletes every table first, in the same transaction.
 *
 * `insertRun` and `deleteAll` are part of the same flush (they cannot await in
 * the synchronous Store API); the request wrapper always flushes.
 *
 * The SQL client is injected (`SqlLike`) so tests run against a fake.
 * Runs, events, idempotency and attendee rows outside the hydrated snapshot
 * are invisible to this store instance by design.
 */
import { AttendeeResponse, Run, RunEvent } from "./contracts";
import { IdempotencyReplay, NotFound, VersionConflict, type NewEvent, type Store, type StoredResponse } from "./store";

export type SqlRow = Record<string, unknown>;

/** The tiny slice of postgres.js the store needs (see `postgresSqlLike`). */
export interface SqlLike {
  query(text: string, params?: readonly unknown[]): Promise<SqlRow[]>;
  transaction<T>(fn: (tx: SqlLike) => Promise<T>): Promise<T>;
}

export interface HydrateOptions {
  /** Load this run instead of the current one. */
  runId?: string;
  /** Load the run behind this attendee link token (takes precedence over the current run). */
  token?: string;
}

export interface SupabaseStore extends Store {
  hydrate(opts?: HydrateOptions): Promise<void>;
  /** Write the snapshot delta in one transaction. Throws VersionConflict when the run moved since hydrate. */
  flush(): Promise<void>;
  /** True when the snapshot holds writes that `flush` has not written yet. */
  readonly dirty: boolean;
}

interface RunRow {
  version: number;
  createdAt: string;
  updatedAt: string;
  state: string;
  /** Version at hydrate (null = inserted in this snapshot). */
  baseVersion: number | null;
  /** Number of events at hydrate. */
  baseSeq: number;
}

interface IdemRow {
  runId: string;
  key: string;
  response: string;
  createdAt: string;
}

const CURRENT = "current_run_id";

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
    return JSON.parse(JSON.stringify(ev)) as RunEvent;
  });
}

function toEvent(row: SqlRow): RunEvent {
  return RunEvent.parse({
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    type: row.type,
    at: row.at,
    ...(row.cause_id ? { causeId: row.cause_id } : {}),
    summary: row.summary,
    payload: JSON.parse(String(row.payload)),
  });
}

function byResponseOrder(a: AttendeeResponse, b: AttendeeResponse): number {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  return a.respondentId < b.respondentId ? -1 : a.respondentId > b.respondentId ? 1 : 0;
}

/** Multi-row VALUES list: `($1,$2),($3,$4)…` for `cols` columns per row. */
function valuesList(rows: number, cols: number): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) out.push(`(${Array.from({ length: cols }, (_, c) => `$${r * cols + c + 1}`).join(", ")})`);
  return out.join(", ");
}

const CHUNK = 200;

export function createSupabaseStore(opts: { sql: SqlLike }): SupabaseStore {
  const { sql } = opts;
  const runs = new Map<string, RunRow>();
  const events = new Map<string, RunEvent[]>();
  const idempotency = new Map<string, Map<string, string>>();
  const newIdem: IdemRow[] = [];
  const meta = new Map<string, string>();
  let metaBase: string | null = null;
  const attendeeLinks = new Map<string, string>();
  const newLinks: Array<{ token: string; runId: string }> = [];
  const attendeeResponses = new Map<string, Map<string, AttendeeResponse>>();
  const dirtyResponses = new Map<string, AttendeeResponse & { runId: string }>();
  let cleared = false;

  function clearSnapshot(): void {
    runs.clear();
    events.clear();
    idempotency.clear();
    newIdem.length = 0;
    meta.clear();
    attendeeLinks.clear();
    newLinks.length = 0;
    attendeeResponses.clear();
    dirtyResponses.clear();
  }

  function isDirty(): boolean {
    if (cleared || newIdem.length || newLinks.length || dirtyResponses.size) return true;
    if ((meta.get(CURRENT) ?? null) !== metaBase) return true;
    for (const row of runs.values()) if (row.baseVersion === null || row.baseVersion !== row.version) return true;
    return false;
  }

  async function hydrate(h: HydrateOptions = {}): Promise<void> {
    clearSnapshot();
    cleared = false;
    const metaRows = await sql.query("SELECT v FROM meta WHERE k = $1", [CURRENT]);
    metaBase = metaRows[0] ? String(metaRows[0].v) : null;
    if (metaBase !== null) meta.set(CURRENT, metaBase);

    let runId: string | null = h.runId ?? null;
    if (h.token) {
      const link = await sql.query("SELECT run_id FROM attendee_links WHERE token = $1", [h.token]);
      if (link[0]) {
        attendeeLinks.set(h.token, String(link[0].run_id));
        runId = runId ?? String(link[0].run_id);
      }
    }
    runId = runId ?? metaBase;
    if (!runId) return;

    const runRows = await sql.query("SELECT id, version, created_at, updated_at, state FROM runs WHERE id = $1", [runId]);
    const row = runRows[0];
    if (!row) return;
    const run = Run.parse(JSON.parse(String(row.state)));
    if (run.id !== runId || run.version !== Number(row.version)) throw new VersionConflict("Stored run row is inconsistent; retry.");
    // Events up to the run's lastSeq were committed with (or before) this version; later ones belong to a newer version.
    const evs = (await sql.query("SELECT * FROM events WHERE run_id = $1 AND seq <= $2 ORDER BY seq ASC", [runId, run.lastSeq])).map(toEvent);
    if (evs.length !== run.lastSeq || evs.some((e, i) => e.seq !== i + 1)) throw new VersionConflict("Run events changed while loading (reset?); retry.");
    runs.set(runId, { version: run.version, createdAt: String(row.created_at), updatedAt: String(row.updated_at), state: JSON.stringify(run), baseVersion: run.version, baseSeq: evs.length });
    events.set(runId, evs);

    const idem = new Map<string, string>();
    for (const r of await sql.query("SELECT key, response FROM idempotency WHERE run_id = $1", [runId])) idem.set(String(r.key), String(r.response));
    if (idem.size) idempotency.set(runId, idem);

    const resp = new Map<string, AttendeeResponse>();
    for (const r of await sql.query("SELECT respondent_id, preference, party_size, submitted_at FROM attendee_responses WHERE run_id = $1", [runId])) {
      const ok = AttendeeResponse.safeParse({ respondentId: r.respondent_id, preference: r.preference, partySize: Number(r.party_size), submittedAt: r.submitted_at });
      if (ok.success) resp.set(ok.data.respondentId, ok.data);
    }
    if (resp.size) attendeeResponses.set(runId, resp);

    for (const r of await sql.query("SELECT token FROM attendee_links WHERE run_id = $1", [runId])) attendeeLinks.set(String(r.token), runId);
  }

  async function writeEvents(tx: SqlLike, list: RunEvent[]): Promise<void> {
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const params = chunk.flatMap((ev) => [ev.runId, ev.seq, ev.id, ev.type, ev.at, ev.causeId ?? null, ev.summary, JSON.stringify(ev.payload)]);
      await tx.query(`INSERT INTO events (run_id, seq, id, type, at, cause_id, summary, payload) VALUES ${valuesList(chunk.length, 8)}`, params);
    }
  }

  async function flush(): Promise<void> {
    if (!isDirty()) return;
    await sql.transaction(async (tx) => {
      if (cleared) {
        for (const t of ["runs", "events", "idempotency", "meta", "attendee_responses", "attendee_links"]) await tx.query(`DELETE FROM ${t}`);
      }
      for (const [id, row] of runs) {
        const state = JSON.stringify(Run.parse(JSON.parse(row.state)));
        if (row.baseVersion === null) {
          await tx.query("INSERT INTO runs (id, version, created_at, updated_at, state) VALUES ($1, $2, $3, $4, $5)", [id, row.version, row.createdAt, row.updatedAt, state]);
        } else if (row.version !== row.baseVersion) {
          const updated = await tx.query("UPDATE runs SET version = $1, updated_at = $2, state = $3 WHERE id = $4 AND version = $5 RETURNING id", [row.version, row.updatedAt, state, id, row.baseVersion]);
          if (updated.length !== 1) throw new VersionConflict(undefined, { expectedVersion: row.baseVersion });
        } else continue;
        await writeEvents(tx, (events.get(id) ?? []).slice(row.baseSeq));
      }
      for (const r of newIdem) {
        await tx.query("INSERT INTO idempotency (run_id, key, response, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, key) DO NOTHING", [r.runId, r.key, r.response, r.createdAt]);
      }
      for (const l of newLinks) await tx.query("INSERT INTO attendee_links (token, run_id) VALUES ($1, $2)", [l.token, l.runId]);
      for (const r of dirtyResponses.values()) {
        await tx.query(
          "INSERT INTO attendee_responses (run_id, respondent_id, preference, party_size, submitted_at) VALUES ($1, $2, $3, $4, $5) " +
            "ON CONFLICT (run_id, respondent_id) DO UPDATE SET preference = excluded.preference, party_size = excluded.party_size, submitted_at = excluded.submitted_at",
          [r.runId, r.respondentId, r.preference, r.partySize, r.submittedAt],
        );
      }
      const cur = meta.get(CURRENT) ?? null;
      if (cur !== null && (cleared || cur !== metaBase)) {
        let ok: SqlRow[];
        if (cleared) ok = await tx.query("INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = excluded.v RETURNING k", [CURRENT, cur]);
        else if (metaBase === null) ok = await tx.query("INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING RETURNING k", [CURRENT, cur]);
        else ok = await tx.query("UPDATE meta SET v = $1 WHERE k = $2 AND v = $3 RETURNING k", [cur, CURRENT, metaBase]);
        if (ok.length !== 1) throw new VersionConflict("The current run changed while this request ran; retry.");
      }
    });
    // Written: the snapshot becomes the new baseline.
    cleared = false;
    metaBase = meta.get(CURRENT) ?? null;
    for (const [id, row] of runs) {
      row.baseVersion = row.version;
      row.baseSeq = events.get(id)?.length ?? 0;
    }
    newIdem.length = 0;
    newLinks.length = 0;
    dirtyResponses.clear();
  }

  return {
    hydrate,
    flush,
    get dirty() {
      return isDirty();
    },

    getRun(id) {
      const row = runs.get(id);
      return row ? Run.parse(JSON.parse(row.state)) : null;
    },

    getCurrentRunId() {
      return meta.get(CURRENT) ?? null;
    },

    setCurrentRunId(id) {
      meta.set(CURRENT, id);
    },

    listEvents(runId, afterSeq = 0, limit = 1000) {
      const out: RunEvent[] = [];
      for (const e of events.get(runId) ?? []) {
        if (e.seq <= afterSeq) continue;
        if (out.length >= limit) break;
        out.push(structuredClone(e));
      }
      return out;
    },

    listEventsByCause(runId, causeId) {
      return (events.get(runId) ?? []).filter((e) => e.causeId === causeId).map((e) => structuredClone(e));
    },

    getIdempotent(runId, key) {
      const raw = idempotency.get(runId)?.get(key);
      return raw ? (JSON.parse(raw) as StoredResponse) : null;
    },

    commit({ run, expectedVersion, events: newEvents, idempotent }) {
      const cur = runs.get(run.id);
      if (!cur) throw new NotFound(`Run ${run.id} not found.`);
      if (cur.version !== expectedVersion) throw new VersionConflict(undefined, { expectedVersion, actualVersion: cur.version });
      if (idempotent) {
        const existing = idempotency.get(run.id)?.get(idempotent.key);
        if (existing) throw new IdempotencyReplay(JSON.parse(existing) as StoredResponse);
      }
      const list = events.get(run.id) ?? [];
      const maxSeq = list.length ? list[list.length - 1]!.seq : 0;
      const next = Run.parse({ ...run, version: expectedVersion + 1, lastSeq: maxSeq + newEvents.length });
      const built = buildEvents(run.id, maxSeq, newEvents);
      let response: string | null = null;
      if (idempotent) {
        const body = typeof idempotent.body === "function" ? (idempotent.body as (r: Run) => unknown)(next) : (idempotent.body ?? { run: next });
        response = JSON.stringify({ status: idempotent.status ?? 200, body } satisfies StoredResponse);
      }
      const state = JSON.stringify(next);
      runs.set(run.id, { ...cur, version: next.version, updatedAt: next.updatedAt, state });
      events.set(run.id, list.concat(built));
      if (idempotent && response !== null) {
        let m = idempotency.get(run.id);
        if (!m) idempotency.set(run.id, (m = new Map()));
        m.set(idempotent.key, response);
        newIdem.push({ runId: run.id, key: idempotent.key, response, createdAt: next.updatedAt });
      }
      return Run.parse(JSON.parse(state));
    },

    insertRun(run, newEvents = []) {
      if (runs.has(run.id)) throw new Error(`Run ${run.id} already exists.`);
      const next = Run.parse({ ...run, lastSeq: newEvents.length });
      const built = buildEvents(next.id, 0, newEvents);
      const state = JSON.stringify(next);
      runs.set(next.id, { version: next.version, createdAt: next.createdAt, updatedAt: next.updatedAt, state, baseVersion: null, baseSeq: 0 });
      events.set(next.id, built);
      return Run.parse(JSON.parse(state));
    },

    deleteAll() {
      clearSnapshot();
      cleared = true;
    },

    close() {
      // The SQL client is owned by the caller.
    },

    putAttendeeLink(token, runId) {
      if (attendeeLinks.has(token)) throw new Error("Attendee link token already exists.");
      attendeeLinks.set(token, runId);
      newLinks.push({ token, runId });
    },

    findRunIdByAttendeeToken(token) {
      return attendeeLinks.get(token) ?? null;
    },

    upsertAttendeeResponse(runId, response) {
      const r = AttendeeResponse.parse(response);
      const clean: AttendeeResponse = { respondentId: r.respondentId, preference: r.preference, partySize: r.partySize, submittedAt: r.submittedAt };
      let m = attendeeResponses.get(runId);
      if (!m) attendeeResponses.set(runId, (m = new Map()));
      m.set(r.respondentId, clean);
      dirtyResponses.set(`${runId}\u0000${r.respondentId}`, { ...clean, runId });
    },

    listAttendeeResponses(runId) {
      return [...(attendeeResponses.get(runId)?.values() ?? [])].sort(byResponseOrder).map((r) => AttendeeResponse.parse(structuredClone(r)));
    },
  };
}
