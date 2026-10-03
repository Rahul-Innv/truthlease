/** Regression tests for findings from the independent review. */
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../src/lib/contracts";
import { fixedClock, presetRequest, PRESET_TEXT } from "../src/lib/fixtures";
import { computeExposure } from "../src/lib/ledger";
import { localProvider } from "../src/lib/providers/local";
import { createService, ValidationError, type Service } from "../src/lib/service";
import { openStore, type Store } from "../src/lib/store";

let store: Store;
afterEach(() => store?.close());

function setup() {
  store = openStore(":memory:");
  const service = createService({ store, clock: fixedClock(), provider: localProvider(), paceMs: 0 });
  return service;
}
const key = (n: string) => `review-key-${n}`;
const currentPlan = (run: Run) => run.plans.find((p) => p.revision === run.currentPlanRevision)!;

async function recoveredAt85(service: Service): Promise<Run> {
  const created = await service.createPresetRun();
  await service.confirmRequirements(created.id);
  let run = await service.drain(created.id);
  run = await service.approve(run.id, { planRevision: run.currentPlanRevision!, idempotencyKey: key("a1") });
  await service.disrupt(run.id, { disruption: { type: "headcount_changed", headcount: 85 }, idempotencyKey: key("h85") });
  run = await service.drain(run.id);
  expect(run.phase).toBe("no_feasible_plan");
  await service.updateBudget(run.id, { budgetCents: 120_000, idempotencyKey: key("b1200") });
  run = await service.drain(run.id);
  expect(run.phase).toBe("needs_approval");
  // Fewest-changes ranking keeps Pelican (approved at 60) rather than switching to the cheaper Swiftline.
  expect(currentPlan(run).selections.map((s) => s.merchantId).sort()).toEqual(["m-bodega", "m-harbor", "m-pelican"]);
  return service.approve(run.id, { planRevision: run.currentPlanRevision!, idempotencyKey: key("a2") });
}

describe("same-supplier revisions carry the order forward (review finding 1)", () => {
  it("a 5-minute delay on Harbor Kitchen's own delivery does not charge Harbor's cancellation terms", async () => {
    const service = setup();
    let run = await recoveredAt85(service);
    expect(run.phase).toBe("simulated_confirmed");
    const approvedTotal = run.plans.find((p) => p.status === "approved")!.totals.totalCents;
    const harborOrder = run.orders.find((o) => o.merchantId === "m-harbor" && o.status === "simulated_confirmed")!;
    expect(harborOrder).toBeDefined();

    await service.disrupt(run.id, { disruption: { type: "delivery_delayed", offerId: harborOrder.offerId, delayMinutes: 5 }, idempotencyKey: key("delay5") });
    run = await service.drain(run.id);
    expect(run.phase).toBe("needs_approval");
    const plan = currentPlan(run);
    // Same package, same price: the delayed revision replaces Harbor's own order with no phantom cancellation cost.
    expect(plan.totals.totalCents).toBe(approvedTotal);
    expect(plan.budget.exposureCents).toBe(approvedTotal);
    expect(plan.selections.find((s) => s.merchantId === "m-harbor")?.change).toBe("requoted");
    expect(plan.selections.filter((s) => s.change === "kept").map((s) => s.merchantId).sort()).toEqual(["m-bodega", "m-pelican"]);

    run = await service.approve(run.id, { planRevision: plan.revision, idempotencyKey: key("a3") });
    const old = run.orders.find((o) => o.id === harborOrder.id)!;
    expect(old.status).toBe("superseded");
    expect(old.cancellation?.retainedCents).toBe(0);
    expect(old.cancellation?.refundStatus).toBe("settled");
    expect(run.ledger.filter((e) => e.kind === "retained")).toHaveLength(0);
    const ex = computeExposure(run.orders, run.ledger);
    expect(ex.exposureCents).toBe(approvedTotal);
    expect(ex.pendingRefundCents).toBe(0);
  });

  it("a supplier that leaves the package still pays its cancellation terms", async () => {
    const service = setup();
    let run = await recoveredAt85(service);
    await service.disrupt(run.id, { disruption: { type: "supplier_unavailable", merchantId: "m-harbor" }, idempotencyKey: key("cancel-harbor") });
    run = await service.drain(run.id);
    const harbor = run.orders.find((o) => o.merchantId === "m-harbor")!;
    expect(harbor.status).toBe("cancelled");
    expect(harbor.cancellation?.retainedCents).toBeGreaterThan(0);
    expect(harbor.cancellation?.refundStatus).toBe("pending");
    expect(computeExposure(run.orders, run.ledger).pendingRefundCents).toBe(harbor.cancellation!.refundCents);
  });
});

describe("idempotency keys are bound to their request body (review finding 5)", () => {
  it("rejects a reused key with a different body instead of replaying", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    const run = await service.drain(created.id);
    const rev = run.currentPlanRevision!;
    const first = await service.approve(run.id, { planRevision: rev, idempotencyKey: key("same") });
    const replay = await service.approve(run.id, { planRevision: rev, idempotencyKey: key("same") });
    expect(replay.version).toBe(first.version);
    await expect(service.approve(run.id, { planRevision: 42, idempotencyKey: key("same") })).rejects.toBeInstanceOf(ValidationError);
    expect(service.getRun(run.id)!.orders.filter((o) => o.status === "simulated_confirmed")).toHaveLength(3);
  });
});

describe("request interpretation is range-safe (review findings 3 and 9)", () => {
  it("treats out-of-range extracted values as missing instead of failing", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    const big = await service.submitRequest(created.id, presetRequest({ text: PRESET_TEXT.replace("60 hackathon attendees", "9000 hackathon attendees") }));
    expect(big.requirements?.missing).toContain("headcount");
    expect(big.requirements?.assumptions.some((a) => a.field === "headcount" && /maximum/.test(a.note))).toBe(true);
    const rich = await service.submitRequest(created.id, presetRequest({ text: PRESET_TEXT.replace("$1,000", "$600,000") }));
    expect(rich.requirements?.missing).toContain("budget");
  });

  it("rejects an unknown time zone with a validation error", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await expect(service.submitRequest(created.id, presetRequest({ timezone: "Not/AZone" }))).rejects.toBeInstanceOf(ValidationError);
  });
});
