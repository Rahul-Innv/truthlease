/**
 * Supabase snapshot store over a fake SqlLike (in-memory tables that interpret
 * exactly the statements the store issues). Covers hydrate → service commands →
 * flush rows, optimistic version conflicts with one retry, idempotency rows,
 * contiguous seqs across request cycles, attendee rows, reset, and the preset
 * flow driven purely by work-on-read across fresh hydrations.
 */
import { describe, expect, it } from "vitest";
import { EXPECTED, fixedClock } from "../src/lib/fixtures";
import { localProvider } from "../src/lib/providers/local";
import { advanceOnRead, isServerless, runRequestCycle } from "../src/lib/serverless";
import { createService, type Service } from "../src/lib/service";
import { VersionConflict } from "../src/lib/store";
import { createSupabaseStore, type SqlLike, type SqlRow, type SupabaseStore } from "../src/lib/store-supabase";

interface Tables {
  runs: Map<string, SqlRow>;
  events: Map<string, SqlRow>;
  idempotency: Map<string, SqlRow>;
  meta: Map<string, SqlRow>;
  attendee_responses: Map<string, SqlRow>;
  attendee_links: Map<string, SqlRow>;
}

const empty = (): Tables => ({ runs: new Map(), events: new Map(), idempotency: new Map(), meta: new Map(), attendee_responses: new Map(), attendee_links: new Map() });
const k2 = (a: unknown, b: unknown) => `${String(a)}\u0000${String(b)}`;

/** A fake postgres: one shared table set, statement matching by shape, transactions roll back on throw. */
function fakeSql() {
  let t = empty();
  const log: string[] = [];
  let beforeUpdate: (() => void) | null = null;

  const exec = (text: string, p: readonly unknown[] = []): SqlRow[] => {
    const s = text.replace(/\s+/g, " ").trim();
    log.push(s);
    if (s.startsWith("SELECT v FROM meta")) return t.meta.has(String(p[0])) ? [t.meta.get(String(p[0]))!] : [];
    if (s.startsWith("SELECT run_id FROM attendee_links WHERE token")) return t.attendee_links.has(String(p[0])) ? [t.attendee_links.get(String(p[0]))!] : [];
    if (s.startsWith("SELECT id, version, created_at, updated_at, state FROM runs")) return t.runs.has(String(p[0])) ? [{ ...t.runs.get(String(p[0]))! }] : [];
    if (s.startsWith("SELECT * FROM events")) return [...t.events.values()].filter((r) => r.run_id === p[0] && Number(r.seq) <= Number(p[1])).sort((a, b) => Number(a.seq) - Number(b.seq));
    if (s.startsWith("SELECT key, response FROM idempotency")) return [...t.idempotency.values()].filter((r) => r.run_id === p[0]);
    if (s.startsWith("SELECT respondent_id")) return [...t.attendee_responses.values()].filter((r) => r.run_id === p[0]);
    if (s.startsWith("SELECT token FROM attendee_links WHERE run_id")) return [...t.attendee_links.values()].filter((r) => r.run_id === p[0]);
    if (s.startsWith("DELETE FROM ")) {
      t[s.slice("DELETE FROM ".length) as keyof Tables].clear();
      return [];
    }
    if (s.startsWith("INSERT INTO runs")) {
      if (t.runs.has(String(p[0]))) throw new Error("duplicate key runs");
      t.runs.set(String(p[0]), { id: p[0], version: p[1], created_at: p[2], updated_at: p[3], state: p[4] });
      return [];
    }
    if (s.startsWith("UPDATE runs")) {
      beforeUpdate?.();
      const row = t.runs.get(String(p[3]));
      if (!row || row.version !== p[4]) return [];
      Object.assign(row, { version: p[0], updated_at: p[1], state: p[2] });
      return [{ id: p[3] }];
    }
    if (s.startsWith("INSERT INTO events")) {
      for (let i = 0; i < p.length; i += 8) {
        const key = k2(p[i], p[i + 1]);
        if (t.events.has(key)) throw new Error("duplicate key events");
        t.events.set(key, { run_id: p[i], seq: p[i + 1], id: p[i + 2], type: p[i + 3], at: p[i + 4], cause_id: p[i + 5], summary: p[i + 6], payload: p[i + 7] });
      }
      return [];
    }
    if (s.startsWith("INSERT INTO idempotency")) {
      const key = k2(p[0], p[1]);
      if (!t.idempotency.has(key)) t.idempotency.set(key, { run_id: p[0], key: p[1], response: p[2], created_at: p[3] });
      return [];
    }
    if (s.startsWith("INSERT INTO attendee_links")) {
      if (t.attendee_links.has(String(p[0]))) throw new Error("duplicate key attendee_links");
      t.attendee_links.set(String(p[0]), { token: p[0], run_id: p[1] });
      return [];
    }
    if (s.startsWith("INSERT INTO attendee_responses")) {
      t.attendee_responses.set(k2(p[0], p[1]), { run_id: p[0], respondent_id: p[1], preference: p[2], party_size: p[3], submitted_at: p[4] });
      return [];
    }
    if (s.startsWith("INSERT INTO meta")) {
      const exists = t.meta.has(String(p[0]));
      if (exists && s.includes("DO NOTHING")) return [];
      t.meta.set(String(p[0]), { k: p[0], v: p[1] });
      return [{ k: p[0] }];
    }
    if (s.startsWith("UPDATE meta")) {
      const row = t.meta.get(String(p[1]));
      if (!row || row.v !== p[2]) return [];
      row.v = p[0];
      return [{ k: p[1] }];
    }
    throw new Error(`fake sql: unhandled statement ${s.slice(0, 60)}`);
  };

  const clone = (x: Tables): Tables => {
    const out = empty();
    for (const name of Object.keys(x) as Array<keyof Tables>) for (const [k, v] of x[name]) out[name].set(k, { ...v });
    return out;
  };

  const sql: SqlLike = {
    query: async (text, params) => exec(text, params),
    transaction: async (fn) => {
      const saved = clone(t);
      try {
        return await fn(sql);
      } catch (err) {
        t = saved;
        throw err;
      }
    },
  };
  return {
    sql,
    get tables() {
      return t;
    },
    log,
    onBeforeUpdate(f: (() => void) | null) {
      beforeUpdate = f;
    },
  };
}

const clock = fixedClock();
const build = (store: SupabaseStore): Service => createService({ store, clock, provider: localProvider(), paceMs: 0, scheduleJob: () => {} });

async function cycle<T>(db: ReturnType<typeof fakeSql>, fn: (s: Service, store: SupabaseStore) => Promise<T>, opts = {}): Promise<T> {
  return runRequestCycle(db.sql, build, fn, opts);
}

const eventSeqs = (db: ReturnType<typeof fakeSql>, runId: string) =>
  [...db.tables.events.values()].filter((r) => r.run_id === runId).map((r) => Number(r.seq)).sort((a, b) => a - b);

describe("supabase store", () => {
  it("is off unless CLEARING_STORE=supabase and SUPABASE_DB_URL are both set", () => {
    expect(isServerless({})).toBe(false);
    expect(isServerless({ CLEARING_STORE: "supabase" })).toBe(false);
    expect(isServerless({ SUPABASE_DB_URL: "postgres://x" })).toBe(false);
    expect(isServerless({ CLEARING_STORE: "supabase", SUPABASE_DB_URL: "postgres://x" })).toBe(true);
  });

  it("hydrate → commands → flush writes the run, contiguous events, idempotency and meta rows", async () => {
    const db = fakeSql();
    const created = await cycle(db, (s) => s.getOrCreateCurrent());
    expect(created.phase).toBe("confirming");
    expect(db.tables.meta.get("current_run_id")?.v).toBe(created.id);
    const row = db.tables.runs.get(created.id)!;
    expect(row.version).toBe(created.version);
    expect(JSON.parse(String(row.state)).phase).toBe("confirming");
    expect(eventSeqs(db, created.id)).toEqual(Array.from({ length: created.lastSeq }, (_, i) => i + 1));

    // Second request cycle: confirm with an idempotency key; seqs stay contiguous across cycles.
    const confirmed = await cycle(db, async (s) => s.confirmRequirements(s.currentRunId()!, { idempotencyKey: "confirm-key-1" }));
    expect(confirmed.phase).toBe("collecting");
    expect(eventSeqs(db, created.id)).toEqual(Array.from({ length: confirmed.lastSeq }, (_, i) => i + 1));
    expect(db.tables.idempotency.get(k2(created.id, "confirm:confirm-key-1"))).toBeTruthy();

    // A replay in a fresh cycle returns the stored response and writes nothing.
    const before = db.tables.runs.get(created.id)!.version;
    const replayed = await cycle(db, async (s) => s.confirmRequirements(s.currentRunId()!, { idempotencyKey: "confirm-key-1" }));
    expect(replayed.version).toBe(confirmed.version);
    expect(db.tables.runs.get(created.id)!.version).toBe(before);
  });

  it("a concurrent version bump between hydrate and flush raises VersionConflict; the cycle retries once and succeeds", async () => {
    const db = fakeSql();
    const created = await cycle(db, (s) => s.getOrCreateCurrent());

    // Direct: snapshot A hydrates, B commits and flushes, A's flush loses.
    const a = createSupabaseStore({ sql: db.sql });
    await a.hydrate();
    const b = createSupabaseStore({ sql: db.sql });
    await b.hydrate();
    await build(b).updateBudget(created.id, { budgetCents: 110_000, idempotencyKey: "budget-key-b" });
    await b.flush();
    await build(a).updateBudget(created.id, { budgetCents: 120_000, idempotencyKey: "budget-key-a" });
    await expect(a.flush()).rejects.toBeInstanceOf(VersionConflict);
    expect(JSON.parse(String(db.tables.runs.get(created.id)!.state)).requirements.budgetCents).toBe(110_000);
    expect(db.tables.idempotency.has(k2(created.id, "budget:budget-key-a"))).toBe(false);
    expect(eventSeqs(db, created.id)).toEqual(Array.from({ length: eventSeqs(db, created.id).length }, (_, i) => i + 1));

    // Through the request cycle: a bump injected right before the first UPDATE forces exactly one retry.
    let injected = false;
    db.onBeforeUpdate(() => {
      if (injected) return;
      injected = true;
      const row = db.tables.runs.get(created.id)!;
      const state = JSON.parse(String(row.state));
      state.version += 1;
      row.version = state.version;
      row.state = JSON.stringify(state);
    });
    let calls = 0;
    const out = await cycle(db, async (s) => {
      calls += 1;
      return s.updateBudget(created.id, { budgetCents: 130_000, idempotencyKey: "budget-key-c" });
    });
    db.onBeforeUpdate(null);
    expect(calls).toBe(2);
    expect(out.requirements?.budgetCents).toBe(130_000);
    expect(db.tables.idempotency.has(k2(created.id, "budget:budget-key-c"))).toBe(true);
  });

  it("attendee links and responses round-trip through hydrate by token", async () => {
    const db = fakeSql();
    const created = await cycle(db, (s) => s.getOrCreateCurrent());
    const linked = await cycle(db, (s) => s.createAttendeeLink(created.id, { idempotencyKey: "link-key-1" }));
    const token = linked.attendeeLink!.token;
    expect(db.tables.attendee_links.get(token)?.run_id).toBe(created.id);

    // Public submit: hydrate by token only (as the attend route does).
    await cycle(db, (s) => s.submitAttendee({ token, respondentId: "browser-a-0001", preference: "vegetarian", partySize: 2 }), { token });
    await cycle(db, (s) => s.submitAttendee({ token, respondentId: "browser-b-0002", preference: "flexible", partySize: 1 }), { token });
    await cycle(db, (s) => s.submitAttendee({ token, respondentId: "browser-a-0001", preference: "flexible", partySize: 3 }), { token });
    expect(db.tables.attendee_responses.size).toBe(2);

    const store = createSupabaseStore({ sql: db.sql });
    await store.hydrate({ token });
    expect(store.findRunIdByAttendeeToken(token)).toBe(created.id);
    const rows = store.listAttendeeResponses(created.id);
    expect(rows.map((r) => [r.respondentId, r.preference, r.partySize])).toEqual(
      expect.arrayContaining([
        ["browser-a-0001", "flexible", 3],
        ["browser-b-0002", "flexible", 1],
      ]),
    );
    const view = await cycle(db, async (s) => s.getAttendeeView(token), { token });
    expect(view.summary.responses).toBe(2);
  });

  it("deleteAll (reset) clears every table and the new preset run becomes current", async () => {
    const db = fakeSql();
    const first = await cycle(db, (s) => s.getOrCreateCurrent());
    await cycle(db, (s) => s.createAttendeeLink(first.id, { idempotencyKey: "link-key-2" }));
    const fresh = await cycle(db, (s) => s.reset());
    expect(fresh.id).not.toBe(first.id);
    expect([...db.tables.runs.keys()]).toEqual([fresh.id]);
    expect(db.tables.attendee_links.size).toBe(0);
    expect([...db.tables.events.values()].every((r) => r.run_id === fresh.id)).toBe(true);
    expect(db.tables.meta.get("current_run_id")?.v).toBe(fresh.id);
    expect(eventSeqs(db, fresh.id)[0]).toBe(1);

    const bare = createSupabaseStore({ sql: db.sql });
    await bare.hydrate();
    bare.deleteAll();
    await bare.flush();
    expect(db.tables.runs.size + db.tables.events.size + db.tables.meta.size + db.tables.idempotency.size).toBe(0);
  });

  it("the preset flow reaches proposed purely through work-on-read across fresh hydrations", async () => {
    const db = fakeSql();
    const created = await cycle(db, (s) => s.getOrCreateCurrent());
    await cycle(db, (s) => s.confirmRequirements(created.id, { idempotencyKey: "confirm-key-wor" }));
    let run = null;
    let reads = 0;
    for (; reads < 100; reads++) {
      run = await cycle(db, async (s) => advanceOnRead(s, s.currentRunId()!, { maxSteps: 3, budgetMs: 2000 }));
      if (!run?.job) break;
    }
    expect(reads).toBeGreaterThan(1); // progress needed several reads (3 steps each)
    expect(run?.phase).toBe("proposed");
    const plan = run!.plans.find((p) => p.revision === run!.currentPlanRevision)!;
    expect(plan.totals.totalCents).toBe(EXPECTED.clearedTotalCents);
    expect(eventSeqs(db, created.id)).toEqual(Array.from({ length: run!.lastSeq }, (_, i) => i + 1));
  });
});
