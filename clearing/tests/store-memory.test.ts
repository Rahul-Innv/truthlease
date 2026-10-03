/**
 * The in-memory store (browser runtime) must behave exactly like the SQLite
 * store: the same scenarios as tests/store.test.ts, plus persistence
 * (hydrate/save round trip, corrupt data dropped) and a full service flow on
 * top of it, including resuming an unfinished job after a "page refresh".
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_CATALOG } from "../src/lib/catalog";
import type { Run } from "../src/lib/contracts";
import { EXPECTED, FIXED_NOW_ISO, fixedClock, presetRequest } from "../src/lib/fixtures";
import { sha256Hex } from "../src/lib/hash";
import { localProvider } from "../src/lib/providers/local";
import { browserIntegrationStatus } from "../src/lib/browser-runtime";
import { IntegrationStatus } from "../src/lib/contracts";
import { createService, ValidationError } from "../src/lib/service";
import { IdempotencyReplay, NotFound, VersionConflict, type NewEvent } from "../src/lib/store";
import { memoryStore, type MemoryStore, type PersistAdapter } from "../src/lib/store-memory";

function baseRun(id = "run_test"): Run {
  return {
    id,
    createdAt: FIXED_NOW_ISO,
    updatedAt: FIXED_NOW_ISO,
    version: 1,
    requestVersion: 1,
    phase: "draft",
    reasoning: "local",
    request: presetRequest(),
    requirements: null,
    merchants: PUBLIC_CATALOG,
    availability: {},
    offers: [],
    negotiation: [],
    plans: [],
    currentPlanRevision: null,
    approvals: [],
    orders: [],
    ledger: [],
    disruptions: [],
    infeasibility: null,
    job: null,
    lastSeq: 0,
    modelCalls: 0,
    lastError: null,
  };
}

const e = (type: NewEvent["type"], summary: string = type, causeId?: string): NewEvent => ({ type, summary, payload: { n: summary }, at: FIXED_NOW_ISO, ...(causeId ? { causeId } : {}) });

/** A synchronous in-memory stand-in for localStorage. */
function memoryPersist(initial: string | null = null): PersistAdapter & { saved: string | null; saves: number } {
  const p = {
    saved: initial,
    saves: 0,
    load: () => p.saved,
    save: (json: string) => {
      p.saved = json;
      p.saves += 1;
    },
  };
  return p;
}

let store: MemoryStore;
afterEach(() => store?.close());

describe("memory store (same scenarios as the SQLite store)", () => {
  it("inserts a run with server-assigned event seqs and reads it back validated", () => {
    store = memoryStore();
    const saved = store.insertRun(baseRun(), [e("run.created")]);
    expect(saved.lastSeq).toBe(1);
    expect(store.getRun("run_test")?.version).toBe(1);
    const [ev] = store.listEvents("run_test");
    expect(ev).toMatchObject({ id: "evt_run_test_1", seq: 1, type: "run.created", runId: "run_test" });
    expect(store.getRun("missing")).toBeNull();
    expect(() => store.insertRun(baseRun())).toThrow();
  });

  it("commit compare-and-swaps on version and assigns contiguous seqs", () => {
    store = memoryStore();
    const r1 = store.insertRun(baseRun(), [e("run.created")]);
    const r2 = store.commit({ run: { ...r1, phase: "confirming" }, expectedVersion: 1, events: [e("request.submitted"), e("requirements.extracted", "x", "job_9")] });
    expect(r2.version).toBe(2);
    expect(r2.lastSeq).toBe(3);
    expect(store.listEvents("run_test", 1).map((x) => x.seq)).toEqual([2, 3]);
    expect(store.listEvents("run_test", 0, 2).map((x) => x.seq)).toEqual([1, 2]);
    expect(store.listEventsByCause("run_test", "job_9").map((x) => x.type)).toEqual(["requirements.extracted"]);

    // A writer holding the stale version loses, and nothing it carried is written.
    expect(() => store.commit({ run: { ...r1, phase: "collecting" }, expectedVersion: 1, events: [e("market.opened")] })).toThrow(VersionConflict);
    expect(store.getRun("run_test")?.phase).toBe("confirming");
    expect(store.listEvents("run_test").length).toBe(3);
    expect(() => store.commit({ run: baseRun("nope"), expectedVersion: 1, events: [] })).toThrow(NotFound);
  });

  it("validates the run with the contract schema on write and writes nothing on failure", () => {
    store = memoryStore();
    const r1 = store.insertRun(baseRun());
    expect(() => store.commit({ run: { ...r1, phase: "bogus" as Run["phase"] }, expectedVersion: 1, events: [e("market.opened")] })).toThrow();
    expect(store.getRun("run_test")?.version).toBe(1);
    expect(store.listEvents("run_test")).toEqual([]);
  });

  it("persists idempotent responses atomically and replays them", () => {
    store = memoryStore();
    const r1 = store.insertRun(baseRun());
    const r2 = store.commit({ run: { ...r1, phase: "confirming" }, expectedVersion: 1, events: [e("request.submitted")], idempotent: { key: "approve:k-12345678" } });
    const stored = store.getIdempotent("run_test", "approve:k-12345678");
    expect(stored?.status).toBe(200);
    expect((stored?.body as { run: Run }).run.version).toBe(r2.version);

    try {
      store.commit({ run: { ...r2, phase: "collecting" }, expectedVersion: 2, events: [e("market.opened")], idempotent: { key: "approve:k-12345678" } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IdempotencyReplay);
      expect((err as IdempotencyReplay).response).toEqual(stored);
    }
    expect(store.getRun("run_test")?.version).toBe(2);
    expect(store.listEvents("run_test").length).toBe(1);
  });

  it("tracks the current run id and deletes everything on reset", () => {
    store = memoryStore();
    store.insertRun(baseRun(), [e("run.created")]);
    store.setCurrentRunId("run_test");
    expect(store.getCurrentRunId()).toBe("run_test");
    store.deleteAll();
    expect(store.getCurrentRunId()).toBeNull();
    expect(store.getRun("run_test")).toBeNull();
    expect(store.listEvents("run_test")).toEqual([]);
  });

  it("never hands out references into its own state", () => {
    store = memoryStore();
    store.insertRun(baseRun(), [e("run.created")]);
    const run = store.getRun("run_test")!;
    run.phase = "collecting";
    const [ev] = store.listEvents("run_test");
    ev!.summary = "tampered";
    expect(store.getRun("run_test")?.phase).toBe("draft");
    expect(store.listEvents("run_test")[0]?.summary).toBe("run.created");
  });

  it("stores attendee links and responses like the SQLite tables", () => {
    store = memoryStore();
    store.insertRun(baseRun());
    store.putAttendeeLink("a".repeat(48), "run_test");
    expect(store.findRunIdByAttendeeToken("a".repeat(48))).toBe("run_test");
    expect(store.findRunIdByAttendeeToken("b".repeat(48))).toBeNull();
    expect(() => store.putAttendeeLink("a".repeat(48), "run_test")).toThrow();
    store.upsertAttendeeResponse("run_test", { respondentId: "resp_b", preference: "vegetarian", partySize: 2, submittedAt: "2026-10-16T21:01:00.000Z" });
    store.upsertAttendeeResponse("run_test", { respondentId: "resp_a", preference: "flexible", partySize: 1, submittedAt: "2026-10-16T21:01:00.000Z" });
    store.upsertAttendeeResponse("run_test", { respondentId: "resp_b", preference: "flexible", partySize: 3, submittedAt: "2026-10-16T21:02:00.000Z" });
    expect(store.listAttendeeResponses("run_test").map((r) => [r.respondentId, r.preference, r.partySize])).toEqual([
      ["resp_a", "flexible", 1],
      ["resp_b", "flexible", 3],
    ]);
  });
});

describe("memory store persistence", () => {
  it("round-trips through the persist adapter and hydrates an identical store", () => {
    const p = memoryPersist();
    store = memoryStore({ persist: p, persistDelayMs: 0 });
    const r1 = store.insertRun(baseRun(), [e("run.created")]);
    store.setCurrentRunId("run_test");
    store.commit({ run: { ...r1, phase: "confirming" }, expectedVersion: 1, events: [e("request.submitted", "s", "job_1")], idempotent: { key: "approve:k-12345678" } });
    expect(p.saves).toBeGreaterThan(0);

    const again = memoryStore({ persist: memoryPersist(p.saved) });
    expect(again.getCurrentRunId()).toBe("run_test");
    expect(again.getRun("run_test")).toEqual(store.getRun("run_test"));
    expect(again.listEvents("run_test")).toEqual(store.listEvents("run_test"));
    expect(again.listEventsByCause("run_test", "job_1").map((x) => x.seq)).toEqual([2]);
    expect(again.getIdempotent("run_test", "approve:k-12345678")).toEqual(store.getIdempotent("run_test", "approve:k-12345678"));
    // CAS continues from the hydrated version.
    expect(() => again.commit({ run: again.getRun("run_test")!, expectedVersion: 1, events: [] })).toThrow(VersionConflict);
    expect(again.commit({ run: again.getRun("run_test")!, expectedVersion: 2, events: [e("market.opened")] }).lastSeq).toBe(3);
  });

  it("debounces saves and flushes on demand", () => {
    const p = memoryPersist();
    store = memoryStore({ persist: p, persistDelayMs: 60_000 });
    store.insertRun(baseRun(), [e("run.created")]);
    store.setCurrentRunId("run_test");
    expect(p.saves).toBe(0);
    store.flush();
    expect(p.saves).toBe(1);
    store.flush(); // nothing new
    expect(p.saves).toBe(1);
  });

  it("drops corrupt data instead of trusting it", () => {
    expect(memoryStore({ persist: memoryPersist("{not json") }).getCurrentRunId()).toBeNull();
    expect(memoryStore({ persist: memoryPersist(JSON.stringify({ format: 99 })) }).getCurrentRunId()).toBeNull();

    const p = memoryPersist();
    const src = memoryStore({ persist: p, persistDelayMs: 0 });
    src.insertRun(baseRun("run_good"), [e("run.created")]);
    src.insertRun(baseRun("run_bad"), [e("run.created")]);
    src.insertRun(baseRun("run_gap"), [e("run.created"), e("request.submitted")]);
    src.setCurrentRunId("run_bad");
    const doc = JSON.parse(p.saved!);
    doc.runs.run_bad.state = JSON.stringify({ ...JSON.parse(doc.runs.run_bad.state), phase: "bogus" });
    doc.events.run_gap = doc.events.run_gap.slice(1); // seq 1 missing
    store = memoryStore({ persist: memoryPersist(JSON.stringify(doc)) });
    expect(store.getRun("run_good")?.id).toBe("run_good");
    expect(store.getRun("run_bad")).toBeNull();
    expect(store.getRun("run_gap")).toBeNull();
    expect(store.listEvents("run_gap")).toEqual([]);
    expect(store.getCurrentRunId()).toBeNull(); // pointed at a dropped run
  });

  it("survives a persist adapter that throws (quota exceeded, private window)", () => {
    store = memoryStore({
      persist: {
        load: () => {
          throw new Error("SecurityError");
        },
        save: () => {
          throw new Error("QuotaExceededError");
        },
      },
      persistDelayMs: 0,
    });
    expect(store.insertRun(baseRun(), [e("run.created")]).lastSeq).toBe(1);
    expect(store.getRun("run_test")?.id).toBe("run_test");
  });
});

describe("service on the memory store", () => {
  it("clears the preset, repairs a Golden Hour cancellation and keeps idempotency", async () => {
    store = memoryStore();
    const service = createService({ store, clock: fixedClock(), provider: localProvider(), paceMs: 0 });
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    const proposed = await service.drain(created.id);
    expect(proposed.phase).toBe("proposed");
    const plan = proposed.plans.find((p) => p.revision === proposed.currentPlanRevision)!;
    expect(plan.totals.totalCents).toBe(EXPECTED.clearedTotalCents);

    const approved = await service.approve(created.id, { planRevision: plan.revision, idempotencyKey: "test-key-approve-1" });
    expect(approved.phase).toBe("simulated_confirmed");
    // Same key, same body: replayed. Same key, different body: refused (fingerprint mismatch).
    expect((await service.approve(created.id, { planRevision: plan.revision, idempotencyKey: "test-key-approve-1" })).version).toBe(approved.version);
    await expect(service.approve(created.id, { planRevision: plan.revision + 1, idempotencyKey: "test-key-approve-1" })).rejects.toBeInstanceOf(ValidationError);

    await service.disrupt(created.id, { disruption: { type: "supplier_unavailable", merchantId: "m-goldenhour" }, idempotencyKey: "test-key-gh" });
    const repaired = await service.drain(created.id);
    expect(repaired.phase).toBe("needs_approval");
    expect(repaired.plans.find((p) => p.revision === repaired.currentPlanRevision)?.totals.totalCents).toBe(EXPECTED.repairedAfterGoldenHourCancelCents);
    // Contiguous seqs across the whole run.
    expect(store.listEvents(created.id, 0, 10_000).map((x) => x.seq)).toEqual(Array.from({ length: repaired.lastSeq }, (_, i) => i + 1));
  });

  it("resumes an unfinished job from persisted state after a refresh", async () => {
    const p = memoryPersist();
    store = memoryStore({ persist: p, persistDelayMs: 0 });
    const s1 = createService({ store, clock: fixedClock(), provider: localProvider(), paceMs: 0 });
    const created = await s1.createPresetRun();
    await s1.confirmRequirements(created.id);
    for (let i = 0; i < 3; i++) await s1.advance(created.id);
    expect(store.getRun(created.id)?.job).not.toBeNull();

    // "Refresh": a new store hydrated from what was saved, a new service, the same job drained to completion.
    const reloaded = memoryStore({ persist: memoryPersist(p.saved) });
    const s2 = createService({ store: reloaded, clock: fixedClock(), provider: localProvider(), paceMs: 0 });
    const done = await s2.drain((await s2.getOrCreateCurrent()).id);
    expect(done.phase).toBe("proposed");
    expect(done.plans.find((x) => x.revision === done.currentPlanRevision)?.totals.totalCents).toBe(EXPECTED.clearedTotalCents);
    reloaded.close();
  });

  it("keeps the persisted document within a localStorage-sized budget for the demo flow", async () => {
    const p = memoryPersist();
    store = memoryStore({ persist: p, persistDelayMs: 0 });
    const service = createService({ store, clock: fixedClock(), provider: localProvider(), paceMs: 0 });
    const run = await service.getOrCreateCurrent();
    await service.confirmRequirements(run.id);
    const proposed = await service.drain(run.id);
    await service.approve(run.id, { planRevision: proposed.currentPlanRevision!, idempotencyKey: "test-key-approve-1" });
    await service.disrupt(run.id, { disruption: { type: "supplier_unavailable", merchantId: "m-goldenhour" }, idempotencyKey: "test-key-gh" });
    await service.drain(run.id);
    // localStorage quotas are ~5 MB of UTF-16; stay well under it.
    expect(p.saved!.length).toBeLessThan(2_000_000);
  });
});

describe("portable helpers", () => {
  it("sha256Hex matches node:crypto byte for byte (so stored fingerprints keep matching)", () => {
    for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), JSON.stringify({ disruption: { type: "x" }, é: "ünïcödé ✓ 🍽" })]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });

  it("the synthesized browser status satisfies the IntegrationStatus contract and claims nothing", () => {
    const st = IntegrationStatus.parse(browserIntegrationStatus());
    expect(st).toMatchObject({ reasoning: { mode: "local", provider: "Local rules" }, coordination: "Local transport", execution: "Simulated orders", paceMs: 350 });
    expect([st.tavily.connected, st.zoowork.connected, st.band.connected]).toEqual([false, false, false]);
  });
});
