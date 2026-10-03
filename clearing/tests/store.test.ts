import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_CATALOG } from "../src/lib/catalog";
import type { Run } from "../src/lib/contracts";
import { FIXED_NOW_ISO, presetRequest } from "../src/lib/fixtures";
import { IdempotencyReplay, NotFound, openStore, VersionConflict, type NewEvent, type Store } from "../src/lib/store";

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

let store: Store;
afterEach(() => store?.close());

describe("store", () => {
  it("inserts a run with server-assigned event seqs and reads it back validated", () => {
    store = openStore(":memory:");
    const saved = store.insertRun(baseRun(), [e("run.created")]);
    expect(saved.lastSeq).toBe(1);
    expect(store.getRun("run_test")?.version).toBe(1);
    const [ev] = store.listEvents("run_test");
    expect(ev).toMatchObject({ id: "evt_run_test_1", seq: 1, type: "run.created", runId: "run_test" });
    expect(store.getRun("missing")).toBeNull();
  });

  it("commit compare-and-swaps on version and assigns contiguous seqs", () => {
    store = openStore(":memory:");
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

  it("validates the run with the contract schema on write", () => {
    store = openStore(":memory:");
    const r1 = store.insertRun(baseRun());
    expect(() => store.commit({ run: { ...r1, phase: "bogus" as Run["phase"] }, expectedVersion: 1, events: [] })).toThrow();
    expect(store.getRun("run_test")?.version).toBe(1);
  });

  it("persists idempotent responses atomically and replays them", () => {
    store = openStore(":memory:");
    const r1 = store.insertRun(baseRun());
    const r2 = store.commit({ run: { ...r1, phase: "confirming" }, expectedVersion: 1, events: [e("request.submitted")], idempotent: { key: "approve:k-12345678" } });
    const stored = store.getIdempotent("run_test", "approve:k-12345678");
    expect(stored?.status).toBe(200);
    expect((stored?.body as { run: Run }).run.version).toBe(r2.version);

    // A second commit carrying the same key is refused as a replay and writes nothing.
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
    store = openStore(":memory:");
    store.insertRun(baseRun(), [e("run.created")]);
    store.setCurrentRunId("run_test");
    expect(store.getCurrentRunId()).toBe("run_test");
    store.deleteAll();
    expect(store.getCurrentRunId()).toBeNull();
    expect(store.getRun("run_test")).toBeNull();
    expect(store.listEvents("run_test")).toEqual([]);
  });

  it("works file-backed (WAL) and creates the directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clearing-store-"));
    const file = path.join(dir, "nested", "clearing.sqlite");
    try {
      store = openStore(file);
      store.insertRun(baseRun(), [e("run.created")]);
      store.close();
      store = openStore(file);
      expect(store.getRun("run_test")?.id).toBe("run_test");
      expect(store.listEvents("run_test").length).toBe(1);
    } finally {
      store.close();
      store = openStore(":memory:");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
