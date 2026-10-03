import { describe, expect, it } from "vitest";
import { CATALOG } from "../src/lib/catalog";
import type { CancellationTerms, SimOrder } from "../src/lib/contracts";
import { MERCHANT_IDS as M, OFFER_IDS } from "../src/lib/fixtures";
import { cancellationExposure, computeExposure, isActiveOrder, sunkOnCancel } from "../src/lib/ledger";
import { pctOf } from "../src/lib/money";
import { buildPlan, explainInfeasibility, solve } from "../src/lib/solver";
import { FIXED_NOW_ISO, cancellationLedger, catalogMerchant, groupsOpen, makeLedger, makeOrder, must, runMarket, validate } from "./helpers";

const terms = (refundablePct: number, settlement: CancellationTerms["settlement"]): CancellationTerms => ({ refundablePct, settlement, note: "test terms" });

describe("isActiveOrder", () => {
  it("is true only for placed and confirmed simulated orders", () => {
    const status = (s: SimOrder["status"]) => isActiveOrder(makeOrder({ id: "o", merchantId: M.bodega, amountCents: 1, status: s }));
    expect(status("simulated_placed")).toBe(true);
    expect(status("simulated_confirmed")).toBe(true);
    expect(status("cancelled")).toBe(false);
    expect(status("superseded")).toBe(false);
  });
});

describe("computeExposure", () => {
  const orders = [
    makeOrder({ id: "o1", merchantId: M.bodega, amountCents: 14_700, status: "simulated_placed" }),
    makeOrder({ id: "o2", merchantId: M.pelican, amountCents: 7_200, status: "simulated_confirmed" }),
    makeOrder({ id: "o3", merchantId: M.goldenHour, amountCents: 56_540, status: "cancelled" }),
    makeOrder({ id: "o4", merchantId: M.juniper, amountCents: 10_000, status: "superseded" }),
  ];
  const ledger = [
    makeLedger("charge", "o1", 14_700),
    makeLedger("charge", "o2", 7_200),
    makeLedger("charge", "o3", 56_540),
    makeLedger("retained", "o3", 2_000),
    makeLedger("retained", "o3", 500),
    makeLedger("refund_pending", "o3", 3_000),
    makeLedger("refund_pending", "o3", 1_000),
    makeLedger("refund_settled", "o3", 9_999), // already settled: not exposure
  ];

  it("sums committed (active orders), retained and pending refunds, and ignores everything else", () => {
    const e = computeExposure(orders, ledger);
    expect(e.committedCents).toBe(14_700 + 7_200); // cancelled and superseded orders are not committed
    expect(e.retainedCents).toBe(2_500);
    expect(e.pendingRefundCents).toBe(4_000);
    expect(e.exposureCents).toBe(21_900 + 2_500 + 4_000);
  });

  it("is zero for an empty run", () => {
    expect(computeExposure([], [])).toEqual({ committedCents: 0, retainedCents: 0, pendingRefundCents: 0, exposureCents: 0 });
  });

  it("charge rows alone never add exposure: the order amount is what is committed", () => {
    const e = computeExposure([orders[0] as SimOrder], [makeLedger("charge", "o1", 14_700)]);
    expect(e).toMatchObject({ committedCents: 14_700, retainedCents: 0, pendingRefundCents: 0, exposureCents: 14_700 });
  });

  it("drops by exactly the pending amount once a pending refund row becomes settled", () => {
    const pending = cancellationLedger("o3", 10_000, 2_000, 8_000, "pending");
    const settled = cancellationLedger("o3", 10_000, 2_000, 8_000, "settled");
    const cancelled = [makeOrder({ id: "o3", merchantId: M.harbor, amountCents: 10_000, status: "cancelled" })];
    const before = computeExposure(cancelled, pending);
    const after = computeExposure(cancelled, settled);
    expect(before.exposureCents).toBe(10_000); // retained 2,000 + pending 8,000
    expect(after.exposureCents).toBe(2_000); // only the nonrefundable 20% stays
    expect(before.exposureCents - after.exposureCents).toBe(8_000);
  });
});

describe("cancellationExposure", () => {
  it("settles a 100% immediate refund and retains nothing", () => {
    const golden = catalogMerchant(M.goldenHour).cancellation;
    expect(golden).toMatchObject({ refundablePct: 100, settlement: "immediate" });
    expect(cancellationExposure(56_540, golden)).toEqual({ retainedCents: 0, refundCents: 56_540, refundStatus: "settled" });
  });

  it("retains 20% and leaves the other 80% as a pending refund (Harbor Kitchen terms)", () => {
    const harbor = catalogMerchant(M.harbor).cancellation;
    expect(harbor).toMatchObject({ refundablePct: 80, settlement: "pending" });
    const c = cancellationExposure(89_132, harbor);
    expect(c.refundCents).toBe(71_306); // 71,305.6 rounds half up
    expect(c.retainedCents).toBe(17_826);
    expect(c.refundStatus).toBe("pending");
    expect(c.retainedCents + c.refundCents).toBe(89_132);
  });

  it("holds a fully refundable but pending refund as pending, with nothing retained", () => {
    const fogline = catalogMerchant(M.fogline).cancellation;
    expect(fogline).toMatchObject({ refundablePct: 100, settlement: "pending" });
    expect(cancellationExposure(19_900, fogline)).toEqual({ retainedCents: 0, refundCents: 19_900, refundStatus: "pending" });
  });

  it("refunds nothing at 0% refundable, whatever the settlement mode", () => {
    for (const settlement of ["immediate", "pending"] as const) {
      expect(cancellationExposure(89_132, terms(0, settlement))).toEqual({ retainedCents: 89_132, refundCents: 0, refundStatus: "none" });
    }
  });

  it("rounds the refund half up to the cent, so the retained share takes the remainder", () => {
    expect(cancellationExposure(1_001, terms(50, "immediate"))).toEqual({ retainedCents: 500, refundCents: 501, refundStatus: "settled" });
  });

  it("always splits an amount into retained + refund with no cent lost or invented", () => {
    for (const amount of [0, 1, 99, 1_001, 14_700, 56_540, 89_132]) {
      for (const pct of [0, 1, 20, 33, 50, 80, 99, 100]) {
        for (const settlement of ["immediate", "pending"] as const) {
          const c = cancellationExposure(amount, terms(pct, settlement));
          expect(c.retainedCents + c.refundCents).toBe(amount);
          expect(c.retainedCents).toBeGreaterThanOrEqual(0);
          expect(c.refundCents).toBe(pctOf(amount, pct));
          const expected = c.refundCents === 0 ? "none" : settlement === "immediate" ? "settled" : "pending";
          expect(c.refundStatus).toBe(expected);
        }
      }
    }
  });
});

describe("sunkOnCancel", () => {
  it("is 0 when a 100% refund settles immediately", () => {
    expect(sunkOnCancel(56_540, terms(100, "immediate"))).toBe(0);
  });

  it("keeps only the retained share when a partial refund settles immediately", () => {
    expect(sunkOnCancel(1_001, terms(50, "immediate"))).toBe(500);
  });

  it("keeps the whole amount exposed for an 80% refund that is still pending (retained 20% + pending 80%)", () => {
    expect(sunkOnCancel(89_132, terms(80, "pending"))).toBe(89_132);
  });

  it("keeps the whole amount exposed when nothing is refundable", () => {
    expect(sunkOnCancel(89_132, terms(0, "immediate"))).toBe(89_132);
    expect(sunkOnCancel(89_132, terms(0, "pending"))).toBe(89_132);
  });

  it("keeps a fully refundable pending refund fully exposed until it settles", () => {
    expect(sunkOnCancel(19_900, terms(100, "pending"))).toBe(19_900);
  });

  it("matches what each catalog merchant's terms leave behind", () => {
    const sunk = Object.fromEntries(CATALOG.map((m) => [m.id, sunkOnCancel(50_000, m.cancellation)]));
    expect(sunk).toEqual({
      [M.juniper]: 0,
      [M.goldenHour]: 0,
      [M.harbor]: 50_000, // 20% retained + 80% pending
      [M.fogline]: 50_000, // 100% refund, pending
      [M.bodega]: 0,
      [M.pelican]: 0,
      [M.swiftline]: 0,
    });
  });

  it("agrees with computeExposure over the ledger rows a cancellation writes", () => {
    for (const m of CATALOG) {
      const amount = 50_001;
      const c = cancellationExposure(amount, m.cancellation);
      const order = makeOrder({ id: `ord_${m.id}`, merchantId: m.id, amountCents: amount, status: "cancelled" });
      const rows = cancellationLedger(order.id, amount, c.retainedCents, c.refundCents, c.refundStatus);
      expect(computeExposure([order], rows).exposureCents).toBe(sunkOnCancel(amount, m.cancellation));
    }
  });
});

describe("pending refunds never restore spendable budget", () => {
  const market = runMarket(); // 60 attendees, $1,000
  const best = must(market.final.best);
  const nothing = { retainedCents: 0, pendingRefundCents: 0 };

  /** A Harbor Kitchen order for 85 attendees, cancelled by the supplier: 20% retained, 80% pending. */
  const harbor85 = runMarket({ headcount: 85 }).latest(M.harbor);
  const harborCancelled = makeOrder({ id: "ord_1_harbor", merchantId: M.harbor, merchantName: harbor85.merchantName, offerId: OFFER_IDS.harbor, offerRevision: harbor85.revision, amountCents: harbor85.totalCents, status: "cancelled" });
  const cancellation = cancellationExposure(harbor85.totalCents, catalogMerchant(M.harbor).cancellation);
  const pendingRows = cancellationLedger(harborCancelled.id, harbor85.totalCents, cancellation.retainedCents, cancellation.refundCents, "pending");
  const settledRows = cancellationLedger(harborCancelled.id, harbor85.totalCents, cancellation.retainedCents, cancellation.refundCents, "settled");

  it("starts from the Harbor numbers: $891.32 order, $178.26 retained, $713.06 pending", () => {
    expect(harbor85.totalCents).toBe(89_132);
    expect(cancellation).toEqual({ retainedCents: 17_826, refundCents: 71_306, refundStatus: "pending" });
  });

  it("counts the pending refund in exposure, so a candidate that fits only if it were refunded is over_budget", () => {
    const exposure = computeExposure([harborCancelled], pendingRows);
    expect(exposure).toEqual({ committedCents: 0, retainedCents: 17_826, pendingRefundCents: 71_306, exposureCents: 89_132 });

    // The candidate fits $1,000 if the pending refund were (wrongly) treated as returned money...
    const ifRefundWereCounted = validate(market, best.offers, { sunkCents: exposure.retainedCents });
    expect(ifRefundWereCounted.exposureCents).toBe(78_440 + 17_826);
    expect(ifRefundWereCounted.feasible).toBe(true);

    // ...but the ledger rule counts it until it settles, so the same candidate is rejected.
    const honest = validate(market, best.offers, { sunkCents: exposure.retainedCents + exposure.pendingRefundCents });
    expect(honest.exposureCents).toBe(78_440 + 89_132);
    expect(honest.rejects).toEqual(["over_budget"]);
    expect(honest.exposureCents - ifRefundWereCounted.exposureCents).toBe(exposure.pendingRefundCents);
  });

  it("makes the whole market infeasible and reports a gap that includes the pending refund", () => {
    const exposure = computeExposure([harborCancelled], pendingRows);
    const sunkCents = exposure.retainedCents + exposure.pendingRefundCents;
    const ctx = { ...market.ctx, sunkCents };
    const result = solve(ctx);
    expect(result.best).toBeNull();
    expect(result.rejectedByReason.over_budget).toBeGreaterThan(0);
    const inf = explainInfeasibility(ctx, result, groupsOpen(market.offers));
    expect(inf.kind).toBe("over_budget");
    expect(must(inf.cheapestInvalid).budgetGapCents).toBe(78_440 + 89_132 - 100_000);
    expect(inf.details.join(" ")).toContain("retained charges and pending refunds");
  });

  it("restores exactly the pending amount once the refund settles, and the candidate becomes feasible", () => {
    const afterSettle = computeExposure([harborCancelled], settledRows);
    expect(afterSettle).toEqual({ committedCents: 0, retainedCents: 17_826, pendingRefundCents: 0, exposureCents: 17_826 });
    const c = validate(market, best.offers, { sunkCents: afterSettle.exposureCents });
    expect(c.feasible).toBe(true);
    expect(c.exposureCents).toBe(96_266);
  });

  it("applies the same rule to a fully refundable pending refund (Fogline, $199.00) at a $900 budget", () => {
    const foglineOrder = makeOrder({ id: "ord_1_fogline", merchantId: M.fogline, offerId: OFFER_IDS.fogline, offerRevision: 2, amountCents: 19_900, status: "cancelled" });
    const c = cancellationExposure(19_900, catalogMerchant(M.fogline).cancellation);
    const rows = cancellationLedger(foglineOrder.id, 19_900, c.retainedCents, c.refundCents, c.refundStatus);
    const exposure = computeExposure([foglineOrder], rows);
    expect(exposure).toMatchObject({ retainedCents: 0, pendingRefundCents: 19_900, exposureCents: 19_900 });
    const tight = { demand: { ...market.demand, budgetCents: 90_000 } };
    expect(validate(market, best.offers, tight).feasible).toBe(true); // no cancellation yet: 784.40 <= 900.00
    const withPending = validate(market, best.offers, { ...tight, sunkCents: exposure.exposureCents });
    expect(withPending.exposureCents).toBe(98_340);
    expect(withPending.rejects).toEqual(["over_budget"]);
    const settled = computeExposure([foglineOrder], cancellationLedger(foglineOrder.id, 19_900, 0, 19_900, "settled"));
    expect(settled.exposureCents).toBe(0);
    expect(validate(market, best.offers, { ...tight, sunkCents: settled.exposureCents }).feasible).toBe(true);
  });

  it("shows retained and pending amounts separately on the plan's budget view, and remaining excludes both", () => {
    const sunkCents = 19_900; // a pending $199.00 refund is still outstanding
    const ctx = { ...market.ctx, sunkCents };
    const candidate = validate(market, best.offers, { sunkCents });
    expect(candidate.feasible).toBe(true);
    const plan = buildPlan({
      ctx,
      result: solve(ctx),
      candidate,
      revision: 2,
      requestVersion: 1,
      createdAt: FIXED_NOW_ISO,
      readyByLocal: "18:30",
      latestArrivalLocal: "18:10",
      budgetCents: 100_000,
      sunk: { retainedCents: 0, pendingRefundCents: 19_900 },
    });
    expect(plan.budget).toEqual({ budgetCents: 100_000, planCents: 78_440, retainedCents: 0, pendingRefundCents: 19_900, exposureCents: 98_340, remainingCents: 1_660 });
    expect(buildPlan({ ctx: market.ctx, result: market.final, candidate: best, revision: 1, requestVersion: 1, createdAt: FIXED_NOW_ISO, readyByLocal: "18:30", latestArrivalLocal: "18:10", budgetCents: 100_000, sunk: nothing }).budget.remainingCents).toBe(21_560);
  });

  it("counts retained and pending cents of dropped orders, not only those already on the ledger", () => {
    // Dropping a still-active Harbor order (80% refundable, pending) leaves its full amount exposed.
    const active = makeOrder({ id: "ord_2_harbor", merchantId: M.harbor, offerId: OFFER_IDS.harbor, offerRevision: 2, amountCents: 89_132 });
    const c = validate(market, best.offers, { previous: { selections: [], activeOrders: [active] } });
    expect(c.exposureCents).toBe(78_440 + 89_132);
    expect(c.rejects).toEqual(["over_budget"]);
  });
});
