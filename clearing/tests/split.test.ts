/** P1 supply assembly: two meal suppliers when no single kitchen can serve the headcount. */
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../src/lib/contracts";
import { EXPECTED, fixedClock, REQUESTS } from "../src/lib/fixtures";
import { localProvider } from "../src/lib/providers/local";
import { createService } from "../src/lib/service";
import { openStore, type Store } from "../src/lib/store";

let store: Store;
afterEach(() => store?.close());
function setup() {
  store = openStore(":memory:");
  return createService({ store, clock: fixedClock(), provider: localProvider(), paceMs: 0 });
}
const plan = (run: Run) => run.plans.find((p) => p.revision === run.currentPlanRevision)!;

describe("supply assembly", () => {
  it("130 attendees: assembles two kitchens plus delivery when no single supplier can serve", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await service.submitRequest(created.id, REQUESTS.assembly);
    await service.confirmRequirements(created.id);
    const run = await service.drain(created.id);
    expect(run.phase).toBe("proposed");
    const p = plan(run);
    const meals = p.selections.filter((s) => s.group === "meals");
    expect(meals).toHaveLength(2);
    expect(meals.map((s) => s.merchantName).sort()).toEqual(["Golden Hour Taqueria", "Harbor Kitchen Collective"]);
    expect(p.coverage.meal_vegetarian.supplied).toBeGreaterThanOrEqual(20);
    expect(p.coverage.meal_vegetarian.supplied + p.coverage.meal_standard.supplied).toBeGreaterThanOrEqual(130);
    // Each kitchen stays within its own capacity; the top-up honours the minimum order.
    const harbor = meals.find((s) => s.merchantId === "m-harbor")!;
    const golden = meals.find((s) => s.merchantId === "m-goldenhour")!;
    expect(harbor.coverage.meal_vegetarian + harbor.coverage.meal_standard).toBe(120);
    expect(golden.coverage.meal_vegetarian + golden.coverage.meal_standard).toBe(20);
    expect(p.selections.some((s) => s.group === "delivery")).toBe(true); // Golden Hour is pickup-only
    expect(p.totals.totalCents).toBe(p.selections.reduce((s, x) => s + x.totalCents, 0));
    expect(p.budget.remainingCents).toBeGreaterThanOrEqual(0);
    const events = store.listEvents(run.id, 0, 10_000);
    expect(events.filter((e) => e.type === "negotiation.requested" && e.payload.lever === "quantity_topup").length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "offer.received" && /Partial|capacity/i.test(String(e.summary)) || (e.type === "offer.received" && Boolean((e.payload as { offer?: { partial?: unknown } }).offer?.partial)))).toBe(true);
    // Never more than two kitchens: three-kitchen sets are rejected, never selected.
    expect(p.evaluation.rejectedByReason.too_many_meal_offers ?? 0).toBeGreaterThan(0);
  });

  it("does not turn a full quote into a top-up while a single supplier could still serve (85 attendees)", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    let run = await service.drain(created.id);
    run = await service.approve(run.id, { planRevision: run.currentPlanRevision!, idempotencyKey: "split-approve-1" });
    await service.disrupt(run.id, { disruption: { type: "headcount_changed", headcount: 85 }, idempotencyKey: "split-85" });
    run = await service.drain(run.id);
    expect(run.phase).toBe("no_feasible_plan");
    expect(run.infeasibility?.cheapestInvalid?.budgetGapCents).toBe(EXPECTED.headcount85GapCents);
    const topups = store.listEvents(run.id, 0, 10_000).filter((e) => e.type === "negotiation.requested" && e.payload.lever === "quantity_topup");
    expect(topups).toHaveLength(0);
    // Golden Hour quoted a partial 70-meal offer instead of leaving the market.
    const golden = run.offers.filter((o) => o.merchantId === "m-goldenhour" && o.status === "open")[0]!;
    expect(golden.partial).toEqual({ coversMeals: 70, ofMeals: 85 });
  });

  it("keeps the 60-attendee preset unchanged (41 candidates, $784.40)", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    const run = await service.drain(created.id);
    expect(plan(run).totals.totalCents).toBe(EXPECTED.clearedTotalCents);
    expect(plan(run).evaluation.candidatesChecked).toBe(41);
  });
});

describe("partial marker survives later revisions", () => {
  it("keeps offer.partial through a volume discount and a slot move", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await service.submitRequest(created.id, REQUESTS.assembly);
    await service.confirmRequirements(created.id);
    const run = await service.drain(created.id);
    for (const merchantId of ["m-harbor", "m-goldenhour", "m-juniper"]) {
      const revs = run.offers.filter((o) => o.merchantId === merchantId).sort((a, b) => a.revision - b.revision);
      expect(revs.length).toBeGreaterThan(1);
      for (const o of revs) expect(o.partial, `${merchantId} r${o.revision}`).toBeDefined();
    }
  });
});
