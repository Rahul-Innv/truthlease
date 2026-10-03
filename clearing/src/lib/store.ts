/**
 * Durable store: SQLite via the built-in `node:sqlite` module (WAL).
 *
 * One row per run holds the authoritative Run JSON plus a `version` used for
 * optimistic compare-and-swap. Events are an append-only table written in the
 * same transaction as the run update, with server-assigned sequence numbers.
 * Idempotent command responses are stored in that same transaction.
 *
 * `node:sqlite` is loaded through `process.getBuiltinModule` so the Next.js
 * bundler never tries to resolve it.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from "node:sqlite";
import { AttendeeResponse, Run, RunEvent, type EventType } from "./contracts";

// ---------------------------------------------------------------------------
// Typed errors shared by the store and the service layer
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The run row moved since it was read (optimistic lock lost). */
export class VersionConflict extends ServiceError {
  constructor(message = "The run changed while this command was running; retry.", details?: unknown) {
    super(409, "version_conflict", message, details);
  }
}

export class NotFound extends ServiceError {
  constructor(message = "Not found.", details?: unknown) {
    super(404, "not_found", message, details);
  }
}

/** A stored response already exists for this idempotency key. */
export class IdempotencyReplay extends Error {
  constructor(readonly response: StoredResponse) {
    super("Idempotent replay");
    this.name = "IdempotencyReplay";
  }
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface NewEvent {
  type: EventType;
  summary: string;
  payload: Record<string, unknown>;
  causeId?: string;
  /** ISO timestamp from the service clock. */
  at: string;
}

export interface CommitTx {
  run: Run;
  expectedVersion: number;
  events: NewEvent[];
  /** Persisted atomically with the state change. `body` may be built from the committed run. */
  idempotent?: { key: string; status?: number; body?: unknown | ((committed: Run) => unknown) };
}

export interface Store {
  getRun(id: string): Run | null;
  getCurrentRunId(): string | null;
  setCurrentRunId(id: string): void;
  listEvents(runId: string, afterSeq?: number, limit?: number): RunEvent[];
  /** Events written with a given causeId (pipeline jobs use their job id). */
  listEventsByCause(runId: string, causeId: string): RunEvent[];
  getIdempotent(runId: string, key: string): StoredResponse | null;
  /** Atomic: CAS on version, append events (assigning seq), persist idempotent response. Throws VersionConflict. */
  commit(tx: CommitTx): Run;
  /** Insert a brand-new run (version as given) with its first events. */
  insertRun(run: Run, events?: NewEvent[]): Run;
  /** Delete every run, event, idempotency record and meta row. */
  deleteAll(): void;
  close(): void;
  // P1 attendee opt-in. The token is a submit-only credential; the run's `attendeeLink` must still carry it.
  putAttendeeLink(token: string, runId: string): void;
  findRunIdByAttendeeToken(token: string): string | null;
  /** Insert or replace one respondent's answer (one row per run + respondentId). */
  upsertAttendeeResponse(runId: string, response: AttendeeResponse): void;
  listAttendeeResponses(runId: string): AttendeeResponse[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  cause_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS events_by_cause ON events (run_id, cause_id);
CREATE TABLE IF NOT EXISTS idempotency (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** P1 attendee opt-in: anonymous answers (no names, emails or phone numbers) and link tokens. */
const ATTENDEE_SCHEMA = `
CREATE TABLE IF NOT EXISTS attendee_responses (
  run_id TEXT NOT NULL,
  respondent_id TEXT NOT NULL,
  preference TEXT NOT NULL,
  party_size INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (run_id, respondent_id)
);
CREATE TABLE IF NOT EXISTS attendee_links (
  token TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function loadSqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule("node:sqlite");
  if (!mod) throw new Error("node:sqlite is unavailable; Node 22.13+ is required.");
  return mod;
}

function toEvent(row: Row): RunEvent {
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

export function openStore(file: string): Store {
  const { DatabaseSync } = loadSqlite();
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db: DatabaseSyncT = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  db.exec(ATTENDEE_SCHEMA);

  const q = {
    getRun: db.prepare("SELECT state FROM runs WHERE id = ?"),
    getVersion: db.prepare("SELECT version FROM runs WHERE id = ?"),
    insertRun: db.prepare("INSERT INTO runs (id, version, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?)"),
    updateRun: db.prepare("UPDATE runs SET version = ?, updated_at = ?, state = ? WHERE id = ? AND version = ?"),
    maxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?"),
    insertEvent: db.prepare("INSERT INTO events (run_id, seq, id, type, at, cause_id, summary, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    listEvents: db.prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"),
    listByCause: db.prepare("SELECT * FROM events WHERE run_id = ? AND cause_id = ? ORDER BY seq ASC"),
    getIdem: db.prepare("SELECT response FROM idempotency WHERE run_id = ? AND key = ?"),
    putIdem: db.prepare("INSERT INTO idempotency (run_id, key, response, created_at) VALUES (?, ?, ?, ?)"),
    getMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
    putMeta: db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
  };

  const qa = {
    putLink: db.prepare("INSERT INTO attendee_links (token, run_id) VALUES (?, ?)"),
    findLink: db.prepare("SELECT run_id FROM attendee_links WHERE token = ?"),
    upsertResponse: db.prepare(
      "INSERT INTO attendee_responses (run_id, respondent_id, preference, party_size, submitted_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(run_id, respondent_id) DO UPDATE SET preference = excluded.preference, party_size = excluded.party_size, submitted_at = excluded.submitted_at",
    ),
    listResponses: db.prepare("SELECT respondent_id, preference, party_size, submitted_at FROM attendee_responses WHERE run_id = ? ORDER BY submitted_at ASC, respondent_id ASC"),
  };

  function tx<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  }

  function appendEvents(runId: string, startSeq: number, events: NewEvent[]): number {
    let seq = startSeq;
    for (const e of events) {
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
      const params: SQLInputValue[] = [runId, seq, ev.id, ev.type, ev.at, ev.causeId ?? null, ev.summary, JSON.stringify(ev.payload)];
      q.insertEvent.run(...params);
    }
    return seq;
  }

  return {
    getRun(id) {
      const row = q.getRun.get(id);
      return row ? Run.parse(JSON.parse(String(row.state))) : null;
    },

    getCurrentRunId() {
      const row = q.getMeta.get("current_run_id");
      return row ? String(row.v) : null;
    },

    setCurrentRunId(id) {
      q.putMeta.run("current_run_id", id);
    },

    listEvents(runId, afterSeq = 0, limit = 1000) {
      return q.listEvents.all(runId, afterSeq, limit).map(toEvent);
    },

    listEventsByCause(runId, causeId) {
      return q.listByCause.all(runId, causeId).map(toEvent);
    },

    getIdempotent(runId, key) {
      const row = q.getIdem.get(runId, key);
      return row ? (JSON.parse(String(row.response)) as StoredResponse) : null;
    },

    commit({ run, expectedVersion, events, idempotent }) {
      return tx(() => {
        const cur = q.getVersion.get(run.id);
        if (!cur) throw new NotFound(`Run ${run.id} not found.`);
        if (Number(cur.version) !== expectedVersion) {
          throw new VersionConflict(undefined, { expectedVersion, actualVersion: Number(cur.version) });
        }
        if (idempotent) {
          const existing = q.getIdem.get(run.id, idempotent.key);
          if (existing) throw new IdempotencyReplay(JSON.parse(String(existing.response)) as StoredResponse);
        }
        const maxSeq = Number(q.maxSeq.get(run.id)?.m ?? 0);
        const next = Run.parse({ ...run, version: expectedVersion + 1, lastSeq: maxSeq + events.length });
        const res = q.updateRun.run(next.version, next.updatedAt, JSON.stringify(next), next.id, expectedVersion);
        if (Number(res.changes) !== 1) throw new VersionConflict();
        appendEvents(run.id, maxSeq, events);
        if (idempotent) {
          const body = typeof idempotent.body === "function" ? (idempotent.body as (r: Run) => unknown)(next) : (idempotent.body ?? { run: next });
          const response: StoredResponse = { status: idempotent.status ?? 200, body };
          q.putIdem.run(run.id, idempotent.key, JSON.stringify(response), next.updatedAt);
        }
        return next;
      });
    },

    insertRun(run, events = []) {
      return tx(() => {
        const next = Run.parse({ ...run, lastSeq: events.length });
        q.insertRun.run(next.id, next.version, next.createdAt, next.updatedAt, JSON.stringify(next));
        appendEvents(next.id, 0, events);
        return next;
      });
    },

    deleteAll() {
      tx(() => {
        db.exec("DELETE FROM runs; DELETE FROM events; DELETE FROM idempotency; DELETE FROM meta; DELETE FROM attendee_responses; DELETE FROM attendee_links;");
      });
    },

    close() {
      db.close();
    },

    putAttendeeLink(token, runId) {
      qa.putLink.run(token, runId);
    },

    findRunIdByAttendeeToken(token) {
      const row = qa.findLink.get(token);
      return row ? String(row.run_id) : null;
    },

    upsertAttendeeResponse(runId, response) {
      const r = AttendeeResponse.parse(response);
      qa.upsertResponse.run(runId, r.respondentId, r.preference, r.partySize, r.submittedAt);
    },

    listAttendeeResponses(runId) {
      return qa.listResponses.all(runId).map((row) =>
        AttendeeResponse.parse({ respondentId: row.respondent_id, preference: row.preference, partySize: Number(row.party_size), submittedAt: row.submitted_at }),
      );
    },
  };
}

/** Default SQLite path, relative to the clearing/ project directory. */
export function appDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), env.CLEARING_DB_PATH || ".data/clearing.sqlite");
}

/** One file-backed store per process, cached on globalThis so it survives dev HMR. */
export function getAppStore(): Store {
  const g = globalThis as typeof globalThis & { __clearingStore?: Store };
  if (!g.__clearingStore) g.__clearingStore = openStore(appDbPath());
  return g.__clearingStore;
}
