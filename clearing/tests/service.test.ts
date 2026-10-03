import { afterEach, describe, expect, it } from "vitest";
import type { Run, RunEvent } from "../src/lib/contracts";
import { EXPECTED, PRESET_TEXT, REQUESTS, fixedClock, presetRequest } from "../src/lib/fixtures";
import { computeExposure } from "../src/lib/ledger";
import { localProvider } from "../src/lib/providers/local";
import type { ReasoningProvider } from "../src/lib/providers/types";
import { OFFER_TTL_MS } from "../src/lib/seller";
import { ApprovalRejected, createService, PhaseError, StaleJob, type Service } from "../src/lib/service";
import { openStore, type Store } from "../src/lib/store";

let store: Store;
afterEach(() => store?.close());

function setup(provider: ReasoningProvider = localProvider()) {
  store = openStore(":memory:");
  const clock = fixedClock();
  const service = createService({ store, clock, provider, paceMs: 0 });
  return { service, clock };
}

const key = (name: string) => `test-key-${name}`;
const events = (runId: string): RunEvent[] => store.listEvents(runId, 0, 10_000);
const ofType = (runId: string, type: RunEvent["type"]) => events(runId).filter((e) => e.type === type);
const currentPlan = (run: Run) => run.plans.find((p) => p.revision === run.currentPlanRevision)!;
const names = (run: Run) => currentPlan(run).selections.map((s) => s.merchantName).sort();
const activeOrders = (run: Run) => run.orders.filter((o) => o.status === "simulated_placed" || o.status === "simulated_confirmed");

async function proposedPreset(service: Service): Promise<Run> {
  const created = await service.createPresetRun();
  expect(created.phase).toBe("confirming");
  await service.confirmRequirements(created.id);
  return service.drain(created.id);
}

async function approvedPreset(service: Service): Promise<Run> {
  const run = await proposedPreset(service);
  return service.approve(run.id, { planRevision: run.currentPlanRevision!, idempotencyKey: key("approve-1") });
}

describe("service: preset flow", () => {
  it("opens the preset in confirming and clears the market at the expected total", async () => {
    const { service } = setup();
    const created = await service.createPresetRun();
    expect(created.requirements).toMatchObject({ headcount: 60, vegetarianMin: 20, readyByLocal: "18:30", budgetCents: 100_000, missing: [] });
    expect(created.request.timezone).toBe("America/Los_Angeles");
    expect(created.request.nowLocal).toBe("14:00");
    expect(created.merchants.every((m) => !("policy" in m))).toBe(true);

    await service.confirmRequirements(created.id);
    const run = await service.drain(created.id);
    expect(run.phase).toBe("proposed");
    expect(run.job).toBeNull();
    const plan = currentPlan(run);
    expect(plan.totals.totalCents).toBe(EXPECTED.clearedTotalCents);
    expect(plan.schedule.slackMinutes).toBe(EXPECTED.clearedSlackMinutes);
    expect(names(run)).toEqual(["Bodega Marquez", "Golden Hour Taqueria", "Pelican Couriers"]);
    expect(plan.evaluation.candidatesChecked).toBe(41);

    expect(ofType(run.id, "market.cleared")).toHaveLength(1);
    expect(ofType(run.id, "plan.proposed")).toHaveLength(1);
    expect(ofType(run.id, "supplier.skipped").map((e) => e.payload.reason)).toEqual(["Minimum order 75 meals > 60 needed"]);
    expect(ofType(run.id, "offer.received")).toHaveLength(6);
    expect(run.negotiation.length).toBeGreaterThan(0);
    // Sequence numbers are server-assigned and contiguous.
    expect(events(run.id).map((e) => e.seq)).toEqual(events(run.id).map((_, i) => i + 1));
    expect(run.lastSeq).toBe(events(run.id).length);
  });

  it("is resumable: a fresh service over the same store finishes a half-run pipeline identically", async () => {
    const { service, clock } = setup();
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    for (let i = 0; i < 9; i++) await service.advance(created.id); // collect + first negotiation units
    const restarted = createService({ store, clock, provider: localProvider(), paceMs: 0 });
    const run = await restarted.drain(created.id);
    expect(currentPlan(run).totals.totalCents).toBe(EXPECTED.clearedTotalCents);
    // advance on a finished run is a safe no-op.
    const again = await restarted.advance(created.id);
    expect(again).toMatchObject({ done: true, step: "idle" });
    expect(again.run.version).toBe(run.version);
  });

  it("treats request text as data: an injected instruction changes nothing", async () => {
    const { service } = setup();
    const created = await service.createPresetRun();
    const run = await service.submitRequest(created.id, REQUESTS.injection);
    expect(run.requirements?.budgetCents).toBe(100_000);
    expect(run.phase).toBe("confirming");
  });
});

describe("service: approval", () => {
  it("places simulated orders and charges, idempotently by key", async () => {
    const { service } = setup();
    const proposed = await proposedPreset(service);
    const cmd = { planRevision: proposed.currentPlanRevision!, idempotencyKey: key("approve-1") };
    const first = await service.approve(proposed.id, cmd);
    const second = await service.approve(proposed.id, cmd);
    expect(second).toEqual(first);
    expect(first.phase).toBe("simulated_confirmed");
    expect(currentPlan(first).status).toBe("approved");
    expect(first.orders).toHaveLength(3);
    expect(first.orders.every((o) => o.status === "simulated_confirmed" && o.simulated)).toBe(true);
    expect(first.ledger.filter((l) => l.kind === "charge").reduce((s, l) => s + l.cents, 0)).toBe(EXPECTED.clearedTotalCents);
    expect(first.approvals).toHaveLength(1);

    const latest = service.getRun(proposed.id)!;
    expect(latest.orders).toHaveLength(3);
    expect(ofType(proposed.id, "plan.approved")).toHaveLength(1);
    expect(ofType(proposed.id, "order.simulated_placed")).toHaveLength(3);
    expect(ofType(proposed.id, "order.simulated_confirmed")).toHaveLength(3);
    const seqs = events(proposed.id).filter((e) => e.type.startsWith("order.")).map((e) => e.type);
    expect(seqs.indexOf("order.simulated_confirmed")).toBeGreaterThan(seqs.lastIndexOf("order.simulated_placed"));
  });

  it("rejects approval of a superseded revision", async () => {
    const { service } = setup();
    const proposed = await proposedPreset(service);
    const rev1 = proposed.currentPlanRevision!;
    await service.disrupt(proposed.id, { disruption: { type: "supplier_unavailable", merchantId: "m-fogline" }, idempotencyKey: key("fogline") });
    const repaired = await service.drain(proposed.id);
    expect(repaired.phase).toBe("needs_approval");
    expect(repaired.currentPlanRevision).toBe(rev1 + 1);
    expect(repaired.plans.find((p) => p.revision === rev1)?.status).toBe("superseded");
    await expect(service.approve(repaired.id, { planRevision: rev1, idempotencyKey: key("old") })).rejects.toBeInstanceOf(PhaseError);
    expect(service.getRun(repaired.id)!.orders).toHaveLength(0);
    const ok = await service.approve(repaired.id, { planRevision: rev1 + 1, idempotencyKey: key("new") });
    expect(ok.phase).toBe("simulated_confirmed");
  });

  it("rejects approval with offer_expired once the clock passes expiresAt", async () => {
    const { service, clock } = setup();
    const proposed = await proposedPreset(service);
    clock.advance(OFFER_TTL_MS + 60_000);
    const attempt = service.approve(proposed.id, { planRevision: proposed.currentPlanRevision!, idempotencyKey: key("late") });
    await expect(attempt).rejects.toBeInstanceOf(ApprovalRejected);
    await attempt.catch((err: ApprovalRejected) => {
      expect(err.status).toBe(409);
      expect(err.rejects).toContain("offer_expired");
    });
    const after = service.getRun(proposed.id)!;
    expect(after.orders).toHaveLength(0);
    expect(after.version).toBe(proposed.version);
  });
});

describe("service: disruption and repair (flagship)", () => {
  it("repairs a Golden Hour cancellation, then headcount 85 is infeasible until the budget rises", async () => {
    const { service } = setup();
    const approved = await approvedPreset(service);
    const id = approved.id;

    // Cancel Golden Hour: full simulated refund settles immediately.
    await service.disrupt(id, { disruption: { type: "supplier_unavailable", merchantId: "m-goldenhour" }, idempotencyKey: key("gh") });
    const repaired = await service.drain(id);
    expect(repaired.phase).toBe("needs_approval");
    const plan = currentPlan(repaired);
    expect(plan.totals.totalCents).toBe(EXPECTED.repairedAfterGoldenHourCancelCents);
    expect(plan.schedule.slackMinutes).toBe(10);
    expect(names(repaired)).toEqual(["Bodega Marquez", "Juniper & Rye Catering", "Swiftline Runners"]);
    expect(plan.selections.find((s) => s.merchantId === "m-bodega")?.change).toBe("kept");
    expect(plan.changeSummary.kept).toEqual(["Bodega Marquez"]);
    expect(plan.changeSummary.widened).toBe("Keeping Pelican Couriers would exceed the budget by $22.14; Swiftline Runners replaces it.");
    const gh = repaired.orders.find((o) => o.merchantId === "m-goldenhour")!;
    expect(gh.status).toBe("cancelled");
    expect(gh.cancellation).toMatchObject({ refundStatus: "settled", retainedCents: 0, refundCents: 56_540 });
    expect(repaired.offers.filter((o) => o.merchantId === "m-goldenhour").every((o) => o.status !== "open")).toBe(true);
    expect(ofType(id, "plan.repaired")).toHaveLength(1);
    expect(ofType(id, "offer.withdrawn").length).toBeGreaterThan(0);

    // Approve the repaired revision: Pelican cancelled under its terms, Juniper + Swiftline placed, Bodega kept.
    const bodegaOrderId = approved.orders.find((o) => o.merchantId === "m-bodega")!.id;
    const reapproved = await service.approve(id, { planRevision: plan.revision, idempotencyKey: key("approve-2") });
    expect(reapproved.phase).toBe("simulated_confirmed");
    expect(reapproved.orders.find((o) => o.merchantId === "m-pelican")?.status).toBe("cancelled");
    expect(reapproved.orders.find((o) => o.merchantId === "m-pelican")?.cancellation?.refundStatus).toBe("settled");
    expect(activeOrders(reapproved).map((o) => o.merchantName).sort()).toEqual(["Bodega Marquez", "Juniper & Rye Catering", "Swiftline Runners"]);
    expect(activeOrders(reapproved).find((o) => o.merchantId === "m-bodega")?.id).toBe(bodegaOrderId);
    expect(reapproved.orders.filter((o) => o.planRevision === plan.revision).map((o) => o.merchantId).sort()).toEqual(["m-juniper", "m-swiftline"]);
    expect(computeExposure(reapproved.orders, reapproved.ledger).exposureCents).toBe(EXPECTED.repairedAfterGoldenHourCancelCents);

    // Headcount 60 → 85 at $1,000: re-quoted, re-negotiated, honestly infeasible.
    await service.disrupt(id, { disruption: { type: "headcount_changed", headcount: 85 }, idempotencyKey: key("85") });
    const blocked = await service.drain(id);
    expect(blocked.phase).toBe("no_feasible_plan");
    expect(blocked.requirements?.headcount).toBe(85);
    expect(blocked.requestVersion).toBe(reapproved.requestVersion + 1);
    expect(blocked.infeasibility?.kind).toBe("over_budget");
    expect(blocked.infeasibility?.cheapestInvalid?.budgetGapCents).toBe(EXPECTED.headcount85GapCents);
    expect(ofType(id, "offer.requoted").length).toBeGreaterThan(0);
    // Courier offers were not re-quoted.
    expect(blocked.offers.filter((o) => o.merchantId === "m-swiftline")).toHaveLength(1);

    // Raise the budget to $1,200: repair with existing offers recovers.
    const raised = await service.updateBudget(id, { budgetCents: 120_000, idempotencyKey: key("1200") });
    expect(raised.requestVersion).toBe(blocked.requestVersion + 1);
    const recovered = await service.drain(id);
    expect(recovered.phase).toBe("needs_approval");
    const p3 = currentPlan(recovered);
    expect(p3.totals.totalCents).toBe(EXPECTED.headcount85RecoveredAt1200Cents);
    expect(names(recovered)).toEqual(["Bodega Marquez", "Harbor Kitchen Collective", "Swiftline Runners"]);
    expect(p3.selections.find((s) => s.merchantId === "m-swiftline")?.change).toBe("kept");
    expect(p3.selections.find((s) => s.merchantId === "m-bodega")?.change).toBe("requoted");
  });

  it("re-quotes a delayed delivery and keeps the old order active until a repair is approved", async () => {
    const { service } = setup();
    const approved = await approvedPreset(service);
    const pelican = approved.orders.find((o) => o.merchantId === "m-pelican")!;
    await service.disrupt(approved.id, { disruption: { type: "delivery_delayed", offerId: pelican.offerId, delayMinutes: 25 }, idempotencyKey: key("delay") });
    const run = await service.drain(approved.id);
    const delayed = run.offers.filter((o) => o.id === pelican.offerId).sort((a, b) => b.revision - a.revision)[0]!;
    expect(delayed.revision).toBe(pelican.offerRevision + 1);
    expect(delayed.fulfillment.timeLocal).toBe("18:15");
    expect(run.orders.find((o) => o.id === pelican.id)?.status).toBe("simulated_confirmed");
    expect(["needs_approval", "no_feasible_plan"]).toContain(run.phase);
  });

  it("disruptions are idempotent by key", async () => {
    const { service } = setup();
    const approved = await approvedPreset(service);
    const cmd = { disruption: { type: "supplier_unavailable" as const, merchantId: "m-goldenhour" }, idempotencyKey: key("dup") };
    const a = await service.disrupt(approved.id, cmd);
    const b = await service.disrupt(approved.id, cmd);
    expect(b).toEqual(a);
    await service.drain(approved.id);
    const c = await service.disrupt(approved.id, cmd);
    expect(c).toEqual(a);
    const run = service.getRun(approved.id)!;
    expect(run.disruptions).toHaveLength(1);
    expect(ofType(approved.id, "disruption.injected")).toHaveLength(1);
    expect(ofType(approved.id, "order.cancelled")).toHaveLength(1);
    await expect(service.disrupt(approved.id, { ...cmd, idempotencyKey: key("other") })).rejects.toBeInstanceOf(PhaseError);
  });

  it("Harbor cancellation leaves retained + pending exposure that blocks a fitting plan until the refund settles", async () => {
    const { service } = setup();
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id, { edits: { headcount: 80, budgetCents: 150_000 } });
    const proposed = await service.drain(created.id);
    expect(names(proposed)).toContain("Harbor Kitchen Collective");
    const approved = await service.approve(proposed.id, { planRevision: proposed.currentPlanRevision!, idempotencyKey: key("harbor-approve") });
    const harborOrder = approved.orders.find((o) => o.merchantId === "m-harbor")!;

    await service.disrupt(approved.id, { disruption: { type: "supplier_unavailable", merchantId: "m-harbor" }, idempotencyKey: key("harbor-cancel") });
    const blocked = await service.drain(approved.id);
    const cancelled = blocked.orders.find((o) => o.id === harborOrder.id)!;
    const retained = Math.round(harborOrder.amountCents * 0.2);
    expect(cancelled.cancellation).toMatchObject({ refundStatus: "pending", retainedCents: retained, refundCents: harborOrder.amountCents - retained });
    const exposure = computeExposure(blocked.orders, blocked.ledger);
    expect(exposure.retainedCents).toBe(retained);
    expect(exposure.pendingRefundCents).toBe(harborOrder.amountCents - retained);
    expect(ofType(approved.id, "refund.pending")).toHaveLength(1);

    // The cheapest replacement fits the budget on its own, but not with the pending refund counted.
    expect(blocked.phase).toBe("no_feasible_plan");
    const inf = blocked.infeasibility!;
    expect(inf.kind).toBe("over_budget");
    const candidateTotal = inf.cheapestInvalid!.totalCents - harborOrder.amountCents; // exposure minus retained+pending
    expect(candidateTotal).toBeLessThanOrEqual(150_000);
    expect(candidateTotal + retained).toBeLessThanOrEqual(150_000);
    expect(inf.cheapestInvalid!.merchants).toContain("Juniper & Rye Catering");

    // Settling the refund restores that headroom and re-evaluates automatically.
    const settling = await service.settleRefund(blocked.id, { orderId: harborOrder.id, idempotencyKey: key("settle") });
    expect(settling.phase).toBe("repairing");
    expect(computeExposure(settling.orders, settling.ledger).pendingRefundCents).toBe(0);
    expect(settling.ledger.filter((l) => l.kind === "refund_pending")).toHaveLength(0);
    const recovered = await service.drain(blocked.id);
    expect(recovered.phase).toBe("needs_approval");
    const plan = currentPlan(recovered);
    expect(plan.totals.totalCents).toBe(candidateTotal);
    expect(plan.budget).toMatchObject({ retainedCents: retained, pendingRefundCents: 0 });
    expect(plan.budget.exposureCents).toBe(candidateTotal + retained);
    await expect(service.settleRefund(blocked.id, { orderId: harborOrder.id, idempotencyKey: key("settle-2") })).rejects.toBeInstanceOf(PhaseError);
  });

  it("cancelling every meal supplier is blocked as no_supply; nothing is invented", async () => {
    const { service } = setup();
    let run = await approvedPreset(service);
    for (const merchantId of ["m-goldenhour", "m-juniper", "m-harbor"]) {
      await service.disrupt(run.id, { disruption: { type: "supplier_unavailable", merchantId }, idempotencyKey: key(`all-${merchantId}`) });
      run = await service.drain(run.id);
    }
    expect(run.phase).toBe("no_feasible_plan");
    expect(run.infeasibility?.kind).toBe("no_supply");
    expect(run.plans.filter((p) => p.status === "proposed")).toHaveLength(0);
  });
});

describe("service: stale jobs", () => {
  it("a pipeline step whose request moved while it ran does not write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = localProvider();
    const gated: ReasoningProvider = {
      ...base,
      mode: base.mode,
      provider: base.provider,
      callsUsed: base.callsUsed,
      interpret: base.interpret,
      chooseSellerLever: base.chooseSellerLever,
      async chooseAsks(candidates, ctx, signal) {
        await gate;
        return base.chooseAsks(candidates, ctx, signal);
      },
    };
    const { service } = setup(gated);
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    let r = await service.advance(created.id);
    while (r.run.phase === "collecting") r = await service.advance(created.id);
    expect(r.run.phase).toBe("negotiating");

    const inFlight = service.advance(created.id); // plans round 1, blocked inside the provider
    const edited = await service.submitRequest(created.id, presetRequest({ text: PRESET_TEXT.replace("Dinner for 60", "Dinner for 70") }));
    expect(edited.requestVersion).toBe(2);
    release();
    await expect(inFlight).rejects.toBeInstanceOf(StaleJob);

    const after = service.getRun(created.id)!;
    expect(after.version).toBe(edited.version);
    expect(after.phase).toBe("confirming");
    expect(after.job).toBeNull();
    expect(ofType(created.id, "negotiation.requested")).toHaveLength(0);
  });

  it("an active job left behind a newer request is discarded and logged as job.failed", async () => {
    const { service } = setup();
    const created = await service.createPresetRun();
    const collecting = await service.confirmRequirements(created.id);
    // Simulate an out-of-band request change that did not replace the job.
    store.commit({ run: { ...collecting, requestVersion: collecting.requestVersion + 1 }, expectedVersion: collecting.version, events: [] });
    await expect(service.advance(created.id)).rejects.toBeInstanceOf(StaleJob);
    const after = service.getRun(created.id)!;
    expect(after.offers).toHaveLength(0);
    expect(after.job).toBeNull();
    expect(ofType(created.id, "job.failed")).toHaveLength(1);
    expect(ofType(created.id, "offer.received")).toHaveLength(0);
  });
});

describe("service: reset and current run", () => {
  it("getOrCreateCurrent creates one preset run; reset replaces it", async () => {
    const { service } = setup();
    const [a, b] = await Promise.all([service.getOrCreateCurrent(), service.getOrCreateCurrent()]);
    expect(a.id).toBe(b.id);
    expect(a.phase).toBe("confirming");
    const fresh = await service.reset();
    expect(fresh.id).not.toBe(a.id);
    expect(service.getRun(a.id)).toBeNull();
    expect((await service.getOrCreateCurrent()).id).toBe(fresh.id);
    expect(events(fresh.id).map((e) => e.type).slice(0, 2)).toEqual(["run.reset", "run.created"]);
  });
});
