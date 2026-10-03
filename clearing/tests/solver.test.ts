import { describe, expect, it } from "vitest";
import { Infeasibility, Plan, type Offer } from "../src/lib/contracts";
import { EXPECTED, EXPECTED_PRESET_NEGOTIATION as NEG, FIXED_NOW_ISO, MERCHANT_IDS as M, OFFER_IDS, REQUESTS } from "../src/lib/fixtures";
import { interpretLocal } from "../src/lib/interpret";
import { sunkOnCancel } from "../src/lib/ledger";
import { formatCents } from "../src/lib/money";
import { delayOffer, OFFER_TTL_MS } from "../src/lib/seller";
import {
  buildPlan,
  compareFresh,
  compareRepair,
  deriveDemand,
  explainInfeasibility,
  nearMisses,
  solve,
  supplied,
  type Candidate,
} from "../src/lib/solver";
import {
  atOffset,
  candidateOfMerchants,
  catalogMerchant,
  choose,
  cloneOffer,
  groupsOpen,
  makeOrder,
  must,
  ordersFor,
  presetRequirements,
  quoteOffer,
  runMarket,
  selectionsFor,
  validate,
  withLines,
} from "./helpers";

// Built once: the solver, buyer and seller never mutate what they are handed, and every
// test that needs a variant clones the offers it changes.
const initial = runMarket({ rounds: 0 });
const negotiated = runMarket();
const best = must(negotiated.final.best, "negotiated best candidate");

/** A budget far above anything in the catalog, to isolate the constraint under test. */
const RICH = 5_000_000;
const rich = (m: { ctx: { demand: object } }) => ({ demand: { ...m.ctx.demand, budgetCents: RICH } }) as { demand: typeof negotiated.demand };

describe("deriveDemand", () => {
  it("derives per-kind requirements, zone and time windows from the preset", () => {
    const d = deriveDemand(presetRequirements());
    expect(d).toMatchObject({
      headcount: 60,
      vegetarianMin: 20,
      zone: "bayfront",
      nowMin: 14 * 60,
      readyByMin: 18 * 60 + 30,
      latestArrivalMin: 18 * 60 + 10, // ready-by minus the 20-minute setup buffer
      budgetCents: 100_000,
    });
    expect(d.required).toEqual({ meal_vegetarian: 20, meal_standard: 40, drink_serving: 60, plate: 60, utensil_set: 60, delivery_run: 0 });
  });

  it("requires nothing for consumables the organizer did not ask for", () => {
    const d = deriveDemand(presetRequirements({ items: { drinks: false, plates: false, utensils: false } }));
    expect([d.required.drink_serving, d.required.plate, d.required.utensil_set]).toEqual([0, 0, 0]);
  });
});

describe("fresh plan on the preset after two negotiation rounds", () => {
  it("has no feasible candidate on the initial quotes alone", () => {
    expect(initial.final.best).toBeNull();
    expect(initial.final.feasibleCandidates).toBe(0);
  });

  it("is feasible with no reject codes", () => {
    expect(best.feasible).toBe(true);
    expect(best.rejects).toEqual([]);
  });

  it("costs $784.40 with 20 minutes of slack", () => {
    expect(best.totalCents).toBe(EXPECTED.clearedTotalCents);
    expect(best.totalCents).toBe(78_440);
    expect(best.slackMinutes).toBe(EXPECTED.clearedSlackMinutes);
    expect(best.slackMinutes).toBe(20);
    expect(best.exposureCents).toBe(best.totalCents); // nothing sunk, nothing previous
  });

  it("selects exactly Bodega + Golden Hour + Pelican, one offer per merchant", () => {
    expect(best.offers.map((o) => o.merchantName).sort()).toEqual([...NEG.bestMerchants].sort());
    expect(new Set(best.offers.map((o) => o.merchantId)).size).toBe(best.offers.length);
  });

  it("covers vegetarian, total meals, drinks, plates and utensils", () => {
    const c = best.coverage;
    expect(c.meal_vegetarian.supplied).toBeGreaterThanOrEqual(20);
    expect(c.meal_vegetarian.supplied + c.meal_standard.supplied).toBeGreaterThanOrEqual(60);
    expect(c.meal_vegetarian).toEqual({ required: 20, supplied: 20 });
    expect(c.meal_standard).toEqual({ required: 40, supplied: 40 });
    expect(c.drink_serving).toEqual({ required: 60, supplied: 60 });
    expect(c.plate).toEqual({ required: 60, supplied: 60 });
    expect(c.utensil_set).toEqual({ required: 60, supplied: 60 });
    expect(c.delivery_run.supplied).toBe(1);
  });

  it("is fully priced and lists the pickup conditions as unresolved", () => {
    expect(best.fullyPriced).toBe(true);
    expect(best.unresolvedConditions.filter((c) => c.startsWith("Unpriced"))).toEqual([]);
    expect(best.unresolvedConditions).toContain("Pickup only: a courier must collect the order.");
  });

  it("derives each price from catalog list prices, not from the solver", () => {
    // Golden Hour: 5% volume price, never below the 94% floor.
    const veg = Math.round(925 * 0.95);
    const std = Math.round(1025 * 0.95);
    expect(veg).toBeGreaterThanOrEqual(Math.ceil((925 * 94) / 100));
    expect(std).toBeGreaterThanOrEqual(Math.ceil((1025 * 94) / 100));
    const golden = 20 * veg + 40 * std;
    const bodega = 60 * 175 + 60 * 40 + 60 * 30;
    const pelican = 7200;
    expect(golden).toBe(NEG.goldenHour.volumeTotalCents);
    expect(best.totalCents).toBe(golden + bodega + pelican);
    expect(best.goodsCents).toBe(golden + bodega);
    expect(best.feesCents).toBe(0);
  });

  it("assigns both pickup offers to the courier and arrives at 5:50 PM", () => {
    expect(best.deliversFor).toEqual({ [OFFER_IDS.pelican]: [OFFER_IDS.bodega, OFFER_IDS.goldenHour] });
    expect(best.lastArrivalMin).toBe(17 * 60 + 50);
    expect(negotiated.demand.latestArrivalMin - best.lastArrivalMin).toBe(best.slackMinutes);
  });
});

describe("vegetarian rule", () => {
  const fogline = negotiated.latest(M.fogline); // re-slotted to 4:30 PM, 60/60/60
  const juniper = initial.latest(M.juniper);

  it("rejects 60 standard meals and 0 vegetarian as dietary_shortfall", () => {
    const allStandard = quoteOffer(M.juniper, { ...initial.demand, vegetarianMin: 0 });
    expect(supplied([allStandard])).toMatchObject({ meal_vegetarian: 0, meal_standard: 60 });
    const c = validate(initial, [allStandard, fogline], rich(initial));
    expect(c.rejects).toEqual(["dietary_shortfall"]); // total meals are fine; only the dietary need fails
    expect(c.feasible).toBe(false);
    expect(c.coverage.meal_vegetarian).toEqual({ required: 20, supplied: 0 });
  });

  it("accepts 60 vegetarian meals alone: they satisfy both the dietary and the headcount constraint", () => {
    const allVeg = quoteOffer(M.juniper, { ...initial.demand, vegetarianMin: 60 });
    expect(supplied([allVeg])).toMatchObject({ meal_vegetarian: 60, meal_standard: 0 });
    const c = validate(initial, [allVeg, fogline], rich(initial));
    expect(c.rejects).toEqual([]);
    expect(c.feasible).toBe(true);
    expect(c.coverage.meal_vegetarian).toEqual({ required: 20, supplied: 60 });
  });

  it("reports incomplete_coverage, not dietary_shortfall, when vegetarian is met but total meals are short", () => {
    const short = quoteOffer(M.juniper, { ...initial.demand, headcount: 59 }); // 20 veg + 39 standard
    const c = validate(initial, [short, fogline], rich(initial));
    expect(c.rejects).toEqual(["incomplete_coverage"]);
  });

  it("never lets standard meals count toward the vegetarian need, even when total meals meet the headcount", () => {
    // 19 vegetarian + 41 standard = 60 meals: the headcount is met, the dietary need (20) is one short.
    const oneShort = withLines(juniper, [{ kind: "meal_vegetarian", qty: 19 }, { kind: "meal_standard", qty: 41 }]);
    const c = validate(initial, [oneShort, fogline], rich(initial));
    expect(c.rejects).toEqual(["dietary_shortfall"]);
    expect(c.coverage.meal_vegetarian).toEqual({ required: 20, supplied: 19 });
    // One more vegetarian meal (20 + 40) clears it.
    const exact = withLines(juniper, [{ kind: "meal_vegetarian", qty: 20 }, { kind: "meal_standard", qty: 40 }]);
    expect(validate(initial, [exact, fogline], rich(initial)).rejects).toEqual([]);
  });
});

describe("cheapest incompatible offers do not win", () => {
  it("rejects Fogline at its 6:15 PM default slot as arrival_too_late until it is re-slotted", () => {
    const juniper = initial.latest(M.juniper);
    const foglineDefault = initial.latest(M.fogline);
    expect(foglineDefault.fulfillment.timeLocal).toBe("18:15");
    const late = validate(initial, [juniper, foglineDefault], rich(initial));
    expect(late.rejects).toEqual(["arrival_too_late"]);
    expect(late.slackMinutes).toBe(-5);

    const early = negotiated.latest(M.fogline);
    expect(early.fulfillment.timeLocal).toBe(NEG.fogline.arrivalLocal);
    expect(early.totalCents).toBe(foglineDefault.totalCents); // same price; only the slot changed
    expect(validate(initial, [juniper, early], rich(initial)).rejects).toEqual([]);
  });

  it("marks every initial candidate that contains Fogline as arrival_too_late", () => {
    const withFogline = initial.final.candidates.filter((c) => c.offers.some((o) => o.merchantId === M.fogline));
    expect(withFogline.length).toBeGreaterThan(0);
    for (const c of withFogline) expect(c.rejects).toContain("arrival_too_late");
  });

  it("ranks the cheapest coverage-complete initial combinations as infeasible, so they cannot win", () => {
    const complete = initial.final.candidates
      .filter((c) => !c.rejects.includes("dietary_shortfall") && !c.rejects.includes("incomplete_coverage"))
      .sort(compareFresh);
    // The two cheapest combinations that would deliver everything with a courier are both invalid as quoted.
    const names = (c: Candidate) => c.offers.map((o) => o.merchantId).sort();
    const goldenBodegaPelican = must(complete.find((c) => names(c).join() === [M.bodega, M.goldenHour, M.pelican].sort().join()));
    expect(goldenBodegaPelican.totalCents).toBe(81_400);
    expect(goldenBodegaPelican.rejects).toEqual(["pickup_too_late"]);
    const goldenFoglineSwiftline = must(complete.find((c) => names(c).join() === [M.fogline, M.goldenHour, M.swiftline].sort().join()));
    expect(goldenFoglineSwiftline.rejects).toEqual(["arrival_too_late"]);
    // Every cheaper coverage-complete candidate is also invalid.
    for (const c of complete.filter((x) => x.totalCents <= goldenFoglineSwiftline.totalCents)) expect(c.feasible).toBe(false);
  });

  it("only beats the cheapest initial coverage-complete combination after its slots were made compatible", () => {
    const initialCheapestCovering = must(candidateOfMerchants(initial.final, [M.bodega, M.goldenHour, M.pelican]));
    expect(initialCheapestCovering.feasible).toBe(false); // as quoted: ready 5:30 PM > pickup-by 5:15 PM
    expect(best.totalCents).toBeLessThan(initialCheapestCovering.totalCents); // 5:00 PM slot plus volume price
    expect(best.offers.find((o) => o.merchantId === M.goldenHour)?.fulfillment.timeLocal).toBe("17:00");
  });

  it("rejects a courier paired only with an included-delivery meal offer as delivery_unused", () => {
    const juniper = initial.latest(M.juniper);
    const pelican = initial.latest(M.pelican);
    const c = validate(initial, [juniper, pelican]);
    expect(c.rejects).toContain("delivery_unused");
    expect(c.rejects).not.toContain("needs_delivery");
    expect(c.deliversFor).toEqual({}); // nothing for the courier to carry
    const withDrinks = validate(initial, [juniper, negotiated.latest(M.fogline), pelican], rich(initial));
    expect(withDrinks.rejects).toEqual(["delivery_unused"]);
  });

  it("rejects two couriers as delivery_unused and never selects two couriers", () => {
    const four = [initial.latest(M.bodega), negotiated.latest(M.goldenHour), initial.latest(M.pelican), initial.latest(M.swiftline)];
    expect(validate(negotiated, four, rich(negotiated)).rejects).toContain("delivery_unused");
    const twoCourierCandidates = negotiated.final.candidates.filter((c) => c.offers.filter((o) => o.fulfillment.mode === "courier").length > 1);
    expect(twoCourierCandidates.length).toBeGreaterThan(0);
    for (const c of twoCourierCandidates) {
      expect(c.rejects).toContain("delivery_unused");
      expect(c.feasible).toBe(false);
    }
  });

  it("rejects pickup-only offers without any courier as needs_delivery", () => {
    expect(validate(initial, [initial.latest(M.goldenHour)]).rejects).toContain("needs_delivery");
  });
});

describe("capacity and delivery are never double-counted", () => {
  const juniper = initial.latest(M.juniper);
  const bodega = initial.latest(M.bodega);
  const golden = initial.latest(M.goldenHour);

  it("rejects two offers from one merchant as duplicate_merchant", () => {
    const dup = cloneOffer(juniper, { id: "off_juniper_dup_v1" });
    expect(validate(initial, [juniper, dup]).rejects).toContain("duplicate_merchant");
  });

  it("skips duplicate-merchant sets during enumeration instead of counting them", () => {
    const dup = cloneOffer(juniper, { id: "off_juniper_dup_v1" });
    const result = solve({ ...initial.ctx, offers: [...initial.ctx.offers, dup] });
    // 7 open offers, minus the one pair and five triples that contain both Juniper offers.
    expect(result.candidatesChecked).toBe(choose(7, 1) + choose(7, 2) + choose(7, 3) - 1 - choose(5, 1));
    expect(result.candidatesChecked).toBe(57);
    for (const c of result.candidates) expect(new Set(c.offers.map((o) => o.merchantId)).size).toBe(c.offers.length);
    expect(result.rejectedByReason.duplicate_merchant ?? 0).toBe(0);
  });

  it("sums capacity per merchant across its offers", () => {
    const half = withLines(juniper, [{ kind: "meal_standard", qty: 50 }]);
    const otherHalf = cloneOffer(half, { id: "off_juniper_second_v1" });
    const over = validate(initial, [half, otherHalf]); // 100 meals against Juniper's 90 capacity
    expect(over.rejects).toEqual(expect.arrayContaining(["capacity_exceeded", "duplicate_merchant"]));

    const fortyFive = withLines(juniper, [{ kind: "meal_standard", qty: 45 }]);
    const atCapacity = validate(initial, [fortyFive, cloneOffer(fortyFive, { id: "off_juniper_second_v1" })]); // exactly 90
    expect(atCapacity.rejects).not.toContain("capacity_exceeded");
  });

  it("rejects a single offer above merchant capacity and accepts one at the limit", () => {
    expect(validate(initial, [withLines(juniper, [{ kind: "meal_standard", qty: 91 }])]).rejects).toContain("capacity_exceeded");
    expect(validate(initial, [withLines(juniper, [{ kind: "meal_standard", qty: 90 }])]).rejects).not.toContain("capacity_exceeded");
    expect(validate(initial, [withLines(bodega, [{ kind: "drink_serving", qty: 151 }])]).rejects).toContain("capacity_exceeded");
    expect(validate(initial, [withLines(bodega, [{ kind: "drink_serving", qty: 150 }])]).rejects).not.toContain("capacity_exceeded");
  });

  it("enforces below_min_order only when a merchant sells meals at all", () => {
    expect(validate(initial, [withLines(golden, [{ kind: "meal_standard", qty: 19 }])]).rejects).toContain("below_min_order");
    expect(validate(initial, [withLines(golden, [{ kind: "meal_standard", qty: 20 }])]).rejects).not.toContain("below_min_order");
    expect(validate(initial, [initial.latest(M.fogline)]).rejects).not.toContain("below_min_order");
  });

  it("rejects more pickups than the courier can carry as courier_capacity", () => {
    const c = validate(initial, [bodega, golden, initial.latest(M.swiftline)]); // Swiftline carries 1 pickup
    expect(c.rejects).toContain("courier_capacity");
    expect(validate(initial, [bodega, golden, initial.latest(M.pelican)]).rejects).not.toContain("courier_capacity"); // Pelican carries 2
  });

  it("makes deliveryCents the included delivery fee plus the courier total, and nothing else", () => {
    const juniperOffer = initial.latest(M.juniper);
    const pelican = initial.latest(M.pelican);
    const c = validate(initial, [juniperOffer, bodega, pelican]);
    expect(juniperOffer.deliveryCents).toBe(4000);
    expect(bodega.deliveryCents).toBeNull(); // pickup-only has no delivery line
    expect(pelican.totalCents).toBe(7200);
    expect(c.deliveryCents).toBe(4000 + 7200);
    expect(c.goodsCents).toBe(79_000 + 14_700);
    expect(c.feesCents).toBe(3950);
    expect(c.totalCents).toBe(c.goodsCents + c.feesCents + c.deliveryCents);
    expect(c.totalCents).toBe(juniperOffer.totalCents + bodega.totalCents + pelican.totalCents);
  });

  it("keeps goods + fees + delivery equal to the sum of offer totals for every evaluated candidate", () => {
    for (const result of negotiated.solves) {
      for (const c of result.candidates) {
        const sumOfOffers = c.offers.reduce((s, o) => s + o.totalCents, 0);
        const includedOrCourier = c.offers.reduce((s, o) => s + (o.fulfillment.mode === "courier" ? o.totalCents : (o.deliveryCents ?? 0)), 0);
        expect(c.totalCents).toBe(c.goodsCents + c.feesCents + c.deliveryCents);
        expect(c.totalCents).toBe(sumOfOffers);
        expect(c.deliveryCents).toBe(includedOrCourier);
      }
    }
  });
});

describe("fulfillment timing", () => {
  it("rejects Golden Hour ready 5:30 PM against Pelican's 5:15 PM pickup-by as pickup_too_late", () => {
    const golden = initial.latest(M.goldenHour);
    const pelican = initial.latest(M.pelican);
    expect(golden.fulfillment.timeLocal).toBe("17:30");
    expect(pelican.fulfillment.pickupByLocal).toBe("17:15");
    const c = validate(initial, [golden, initial.latest(M.bodega), pelican]);
    expect(c.rejects).toEqual(["pickup_too_late"]);
  });

  it("accepts a pickup that is ready exactly at the courier's pickup-by time", () => {
    const c = validate(initial, [initial.latest(M.goldenHour), initial.latest(M.swiftline)]); // 17:30 vs pickup by 17:30
    expect(c.rejects).not.toContain("pickup_too_late");
  });

  it("accepts the same combination once Golden Hour is ready at 5:00 PM", () => {
    const c = validate(negotiated, [negotiated.latest(M.goldenHour), negotiated.latest(M.bodega), negotiated.latest(M.pelican)]);
    expect(c.rejects).toEqual([]);
  });

  it("rejects an arrival after readyBy minus the setup buffer, with negative slack", () => {
    const c = validate(initial, [initial.latest(M.fogline)]);
    expect(c.rejects).toContain("arrival_too_late");
    expect(c.lastArrivalMin).toBe(18 * 60 + 15);
    expect(c.slackMinutes).toBe(-5);
  });
});

describe("offer and merchant validity", () => {
  const juniper = initial.latest(M.juniper);

  it("rejects an offer whose expiresAt is before now, and at now, but not one millisecond later", () => {
    expect(validate(initial, [cloneOffer(juniper, { expiresAt: atOffset(-1) })]).rejects).toContain("offer_expired");
    expect(validate(initial, [cloneOffer(juniper, { expiresAt: FIXED_NOW_ISO })]).rejects).toContain("offer_expired");
    expect(validate(initial, [cloneOffer(juniper, { expiresAt: atOffset(1) })]).rejects).not.toContain("offer_expired");
  });

  it("expires every quoted offer when the clock passes the offer TTL", () => {
    expect(juniper.expiresAt).toBe(atOffset(OFFER_TTL_MS));
    expect(validate(negotiated, best.offers, { nowIso: atOffset(OFFER_TTL_MS - 1) }).feasible).toBe(true);
    const after = validate(negotiated, best.offers, { nowIso: atOffset(OFFER_TTL_MS) });
    expect(after.rejects).toContain("offer_expired");
    const result = solve({ ...negotiated.ctx, nowIso: atOffset(OFFER_TTL_MS) });
    expect(result.best).toBeNull();
    expect(result.feasibleCandidates).toBe(0);
    expect(result.rejectedByReason.offer_expired).toBe(result.candidatesChecked);
  });

  it("rejects offers that are not open, and never enumerates superseded revisions", () => {
    for (const status of ["superseded", "withdrawn", "expired"] as const) {
      expect(validate(initial, [cloneOffer(juniper, { status })]).rejects).toContain("offer_not_open");
    }
    const everyOffer = negotiated.final.candidates.flatMap((c) => c.offers);
    expect(everyOffer.every((o) => o.status === "open")).toBe(true);
    expect(everyOffer.some((o) => o.id === OFFER_IDS.goldenHour && o.revision < 3)).toBe(false);
  });

  it("does not fall back to an older revision when the latest revision is withdrawn", () => {
    const withdrawn = negotiated.ctx.offers.map((o): Offer => (o.id === OFFER_IDS.goldenHour && o.revision === 3 ? { ...o, status: "withdrawn" } : o));
    const result = solve({ ...negotiated.ctx, offers: withdrawn });
    expect(result.candidates.some((c) => c.offers.some((o) => o.merchantId === M.goldenHour))).toBe(false);
    const alt = must(result.best);
    expect(alt.offers.map((o) => o.merchantId)).not.toContain(M.goldenHour);
    expect(alt.totalCents).toBe(EXPECTED.repairedAfterGoldenHourCancelCents); // Bodega + Juniper (8%) + Swiftline
  });

  it("rejects an unavailable merchant as merchant_unavailable and re-plans around it", () => {
    const availability = { [M.pelican]: { available: false, reason: "Supplier cancelled (simulated)" } };
    const c = validate(negotiated, best.offers, { availability });
    expect(c.rejects).toEqual(["merchant_unavailable"]);
    const result = solve({ ...negotiated.ctx, availability });
    for (const cand of result.candidates.filter((x) => x.offers.some((o) => o.merchantId === M.pelican))) expect(cand.rejects).toContain("merchant_unavailable");
    const alt = must(result.best);
    expect(alt.offers.map((o) => o.merchantName).sort()).toEqual(["Fogline Beverage Co.", "Golden Hour Taqueria", "Swiftline Runners"]);
    expect(alt.totalCents).toBe(56_540 + 19_900 + 4_400);
    expect(alt.slackMinutes).toBe(10);
  });

  it("treats a merchant missing from the merchant snapshot as unavailable", () => {
    const merchants = negotiated.ctx.merchants.filter((m) => m.id !== M.pelican);
    expect(validate(negotiated, best.offers, { merchants }).rejects).toContain("merchant_unavailable");
  });

  it("rejects a merchant outside the venue zone as service_area", () => {
    const mission = { demand: { ...initial.demand, zone: "mission" } };
    expect(catalogMerchant(M.bodega).serviceZones).toEqual(["bayfront"]);
    expect(validate(initial, [initial.latest(M.bodega)], mission).rejects).toContain("service_area");
    expect(validate(initial, [initial.latest(M.swiftline)], mission).rejects).toContain("service_area"); // bayfront + soma only
    expect(validate(initial, [juniper], mission).rejects).not.toContain("service_area"); // serves mission
    expect(validate(initial, [juniper]).rejects).not.toContain("service_area");
  });

  it("rejects an offer whose merchant narrowed its zones after quoting", () => {
    const merchants = initial.ctx.merchants.map((m) => (m.id === M.juniper ? { ...m, serviceZones: ["soma"] } : m));
    expect(validate(initial, [juniper], { merchants }).rejects).toContain("service_area");
  });
});

describe("pricing completeness", () => {
  it("rejects an offer with an unpriced entry as not_fully_priced and surfaces the condition", () => {
    const unpriced = cloneOffer(initial.latest(M.juniper), { unpriced: ["Venue loading dock fee"] });
    const c = validate(initial, [unpriced, negotiated.latest(M.fogline)], rich(initial));
    expect(c.rejects).toEqual(["not_fully_priced"]);
    expect(c.fullyPriced).toBe(false);
    expect(c.unresolvedConditions).toContain("Unpriced: Venue loading dock fee");
  });

  it("never selects an unpriced offer from enumeration", () => {
    const offers = negotiated.ctx.offers.map((o): Offer => (o.merchantId === M.bodega && o.status === "open" ? { ...o, unpriced: ["Bag fee"] } : o));
    const result = solve({ ...negotiated.ctx, offers });
    for (const c of result.candidates.filter((x) => x.offers.some((o) => o.merchantId === M.bodega))) {
      expect(c.rejects).toContain("not_fully_priced");
      expect(c.feasible).toBe(false);
    }
    expect(must(result.best).fullyPriced).toBe(true);
  });
});

describe("budget exposure", () => {
  it("is feasible exactly at the budget and over_budget one cent beyond when sunk cents are set", () => {
    const headroom = 100_000 - best.totalCents;
    expect(headroom).toBe(21_560);
    const atBudget = validate(negotiated, best.offers, { sunkCents: headroom });
    expect(atBudget.exposureCents).toBe(100_000);
    expect(atBudget.feasible).toBe(true);
    const over = validate(negotiated, best.offers, { sunkCents: headroom + 1 });
    expect(over.exposureCents).toBe(100_001);
    expect(over.totalCents).toBe(best.totalCents); // sunk is exposure, not part of the plan total
    expect(over.rejects).toEqual(["over_budget"]);
  });

  it("charges the cancellation cost of previously ordered suppliers that a candidate drops", () => {
    const termsFor = negotiated.ctx.cancellationTermsFor;
    const harbor = catalogMerchant(M.harbor);
    expect(harbor.cancellation).toMatchObject({ refundablePct: 80, settlement: "pending" });
    const harborOrder = makeOrder({ id: "ord_1_harbor", merchantId: M.harbor, merchantName: harbor.name, offerId: OFFER_IDS.harbor, offerRevision: 2, amountCents: 89_132 });
    // 20% retained + 80% refund still pending: dropping this order leaves its full amount exposed.
    const dropped = validate(negotiated, best.offers, { previous: { selections: [], activeOrders: [harborOrder] }, cancellationTermsFor: termsFor });
    expect(sunkOnCancel(89_132, harbor.cancellation)).toBe(89_132);
    expect(dropped.exposureCents).toBe(best.totalCents + 89_132);
    expect(dropped.rejects).toEqual(["over_budget"]);
  });

  it("charges nothing for dropping an order whose refund settles immediately, and a pending refund counts in full", () => {
    const candidate = best.offers; // Bodega + Golden Hour (r3) + Pelican
    const foglineOrder = makeOrder({ id: "o_f", merchantId: M.fogline, offerId: OFFER_IDS.fogline, offerRevision: 2, amountCents: 19_900 });
    const dropsFogline = validate(negotiated, candidate, { previous: { selections: [], activeOrders: [foglineOrder] } });
    expect(catalogMerchant(M.fogline).cancellation).toMatchObject({ refundablePct: 100, settlement: "pending" });
    expect(dropsFogline.exposureCents).toBe(best.totalCents + 19_900); // 100% refund, but still pending

    const juniperOrder = makeOrder({ id: "o_j", merchantId: M.juniper, offerId: OFFER_IDS.juniper, offerRevision: 2, amountCents: 80_314 });
    expect(catalogMerchant(M.juniper).cancellation).toMatchObject({ refundablePct: 100, settlement: "immediate" });
    expect(validate(negotiated, candidate, { previous: { selections: [], activeOrders: [juniperOrder] } }).exposureCents).toBe(best.totalCents);

    const goldenOrder = makeOrder({ id: "o_g", merchantId: M.goldenHour, offerId: OFFER_IDS.goldenHour, offerRevision: 3, amountCents: 56_540 });
    const keptBodega = makeOrder({ id: "o_h", merchantId: M.bodega, offerId: OFFER_IDS.bodega, offerRevision: 1, amountCents: 14_700 });
    // Orders whose exact (offerId, revision) the candidate selects are kept, so nothing is cancelled.
    expect(validate(negotiated, candidate, { previous: { selections: [], activeOrders: [goldenOrder, keptBodega] } }).exposureCents).toBe(best.totalCents);
  });

  it("assumes the full amount stays exposed when cancellation terms are unknown", () => {
    const orphan = makeOrder({ id: "o_x", merchantId: "m-mystery", offerId: "off_mystery_v1", offerRevision: 1, amountCents: 5_000 });
    const c = validate(negotiated, best.offers, { previous: { selections: [], activeOrders: [orphan] }, cancellationTermsFor: () => undefined });
    expect(c.exposureCents).toBe(best.totalCents + 5_000);
  });
});

describe("repair ranking", () => {
  const goldenOffer = must(best.offers.find((o) => o.merchantId === M.goldenHour));
  const previous = { selections: selectionsFor(best.offers), activeOrders: ordersFor(best.offers) };
  const score = (offers: Offer[]) => validate(negotiated, offers, { previous }).changeScore;

  it("scores 0 for keeping everything, 1 for a same-merchant re-quote, 2 for a new merchant", () => {
    expect(score(best.offers)).toBe(0);

    const pelican = must(best.offers.find((o) => o.merchantId === M.pelican));
    const delayed = delayOffer(pelican, 5, FIXED_NOW_ISO); // new revision, same merchant
    expect(delayed.revision).toBe(pelican.revision + 1);
    const requoted = best.offers.map((o) => (o.id === pelican.id ? delayed : o));
    expect(score(requoted)).toBe(1);

    expect(score([...best.offers, negotiated.latest(M.fogline)])).toBe(2); // one added merchant, nothing removed
  });

  it("adds one for each previous merchant a candidate removes", () => {
    const [bodega, golden] = [must(best.offers.find((o) => o.merchantId === M.bodega)), goldenOffer];
    expect(score([bodega, golden])).toBe(1); // Pelican removed
    expect(score([bodega])).toBe(2); // Golden and Pelican removed
    // Swap Pelican for a new courier: new merchant (2) + removed Pelican (1)
    expect(score([bodega, golden, negotiated.latest(M.swiftline)])).toBe(3);
  });

  it("orders by changeScore, then exposure, then slack, then a stable key, regardless of cost", () => {
    const [bodega, juniper] = [must(best.offers.find((o) => o.merchantId === M.bodega)), negotiated.latest(M.juniper)];
    const mk = (patch: Partial<Candidate>, offers: Offer[] = best.offers): Candidate => ({ ...best, offers, ...patch });

    const fewerChangesButPricier = mk({ changeScore: 0, exposureCents: 90_000, slackMinutes: 0 });
    const moreChangesButCheaper = mk({ changeScore: 1, exposureCents: 10_000, slackMinutes: 60 });
    expect(compareRepair(fewerChangesButPricier, moreChangesButCheaper)).toBeLessThan(0);
    expect(compareFresh(fewerChangesButPricier, moreChangesButCheaper)).toBeGreaterThan(0); // fresh ranking would pick the other

    expect(compareRepair(mk({ changeScore: 2, exposureCents: 500 }), mk({ changeScore: 2, exposureCents: 600 }))).toBeLessThan(0);
    expect(compareRepair(mk({ changeScore: 2, exposureCents: 500, slackMinutes: 30 }), mk({ changeScore: 2, exposureCents: 500, slackMinutes: 10 }))).toBeLessThan(0);
    const keyA = mk({ changeScore: 2, exposureCents: 500, slackMinutes: 10 }, [bodega]);
    const keyB = mk({ changeScore: 2, exposureCents: 500, slackMinutes: 10 }, [juniper]);
    expect(compareRepair(keyA, keyB)).toBeLessThan(0); // off_bodega... sorts before off_juniper...
    expect(compareRepair(keyB, keyA)).toBeGreaterThan(0);
    expect(compareRepair(keyA, keyA)).toBe(0);

    const sorted = [moreChangesButCheaper, keyB, keyA, fewerChangesButPricier].sort(compareRepair);
    expect(sorted).toEqual([fewerChangesButPricier, moreChangesButCheaper, keyA, keyB].sort(compareRepair));
    expect(sorted[0]).toBe(fewerChangesButPricier);
  });

  it("orders fresh candidates by total, then slack, then a stable key", () => {
    const mk = (patch: Partial<Candidate>): Candidate => ({ ...best, ...patch });
    expect(compareFresh(mk({ totalCents: 100 }), mk({ totalCents: 200, slackMinutes: 99 }))).toBeLessThan(0);
    expect(compareFresh(mk({ totalCents: 100, slackMinutes: 20 }), mk({ totalCents: 100, slackMinutes: 10 }))).toBeLessThan(0);
    expect(compareFresh(best, best)).toBe(0);
  });

  describe("after Golden Hour cancels (60 attendees)", () => {
    const cancelGolden = (budgetCents: number) => {
      const remaining = previous.activeOrders.filter((o) => o.merchantId !== M.goldenHour);
      const sunk = sunkOnCancel(goldenOffer.totalCents, catalogMerchant(M.goldenHour).cancellation);
      expect(sunk).toBe(0); // 100% refund, settled immediately
      return runMarket({
        budgetCents,
        availability: { [M.goldenHour]: { available: false, reason: "Supplier cancelled (simulated)" } },
        previous: { selections: previous.selections, activeOrders: remaining },
        sunkCents: sunk,
      });
    };

    it("at $1,000 keeps Bodega, replaces Golden Hour with Juniper, and must widen to Swiftline", () => {
      const m = cancelGolden(100_000);
      const repaired = must(m.final.best);
      expect(repaired.offers.map((o) => o.merchantName).sort()).toEqual(["Bodega Marquez", "Juniper & Rye Catering", "Swiftline Runners"]);
      expect(repaired.totalCents).toBe(EXPECTED.repairedAfterGoldenHourCancelCents);
      expect(repaired.changeScore).toBe(6); // Juniper 2 + Swiftline 2 + removed Golden Hour 1 + removed Pelican 1
      expect(m.final.feasibleCandidates).toBe(1);
      // Keeping Pelican would have been fewer changes, but it exceeds the budget by exactly $22.14.
      const keepPelican = must(candidateOfMerchants(m.final, [M.bodega, M.juniper, M.pelican]));
      expect(keepPelican.rejects).toEqual(["over_budget"]);
      expect(keepPelican.exposureCents - 100_000).toBe(2214);
      expect(keepPelican.changeScore).toBe(3);
    });

    it("at $1,200 prefers keeping Pelican (3 changes, $1,022.14) over the cheaper Swiftline plan (6 changes, $994.14)", () => {
      const m = cancelGolden(120_000);
      const repaired = must(m.final.best);
      expect(repaired.offers.map((o) => o.merchantName).sort()).toEqual(["Bodega Marquez", "Juniper & Rye Catering", "Pelican Couriers"]);
      expect(repaired.totalCents).toBe(102_214);
      expect(repaired.changeScore).toBe(3);
      const cheaper = must(candidateOfMerchants(m.final, [M.bodega, M.juniper, M.swiftline]));
      expect(cheaper.feasible).toBe(true);
      expect(cheaper.totalCents).toBe(99_414);
      expect(cheaper.totalCents).toBeLessThan(repaired.totalCents);
      expect(compareRepair(repaired, cheaper)).toBeLessThan(0);
      expect(compareFresh(repaired, cheaper)).toBeGreaterThan(0);
      // The same market ranked as a fresh plan (no previous) picks the cheapest candidate instead.
      const fresh = runMarket({ budgetCents: 120_000, availability: { [M.goldenHour]: { available: false } } });
      expect(must(fresh.final.best).totalCents).toBe(99_414);
    });

    it("builds a repair plan whose change chips and widened reason follow the selections", () => {
      const m = cancelGolden(100_000);
      const repaired = must(m.final.best);
      const keepPelican = must(candidateOfMerchants(m.final, [M.bodega, M.juniper, M.pelican]));
      const widened = `Keeping ${must(keepPelican.offers.find((o) => o.merchantId === M.pelican)).merchantName} would exceed the budget by ${formatCents(keepPelican.exposureCents - 100_000)}; Swiftline Runners replaces it.`;
      const plan = buildPlan({
        ctx: m.ctx,
        result: m.final,
        candidate: repaired,
        revision: 2,
        basedOnRevision: 1,
        requestVersion: 1,
        createdAt: FIXED_NOW_ISO,
        readyByLocal: "18:30",
        latestArrivalLocal: "18:10",
        budgetCents: 100_000,
        sunk: { retainedCents: 0, pendingRefundCents: 0 },
        widened,
      });
      const byMerchant = Object.fromEntries(plan.selections.map((s) => [s.merchantId, s]));
      expect(byMerchant[M.bodega]).toMatchObject({ change: "kept" });
      expect(byMerchant[M.juniper]).toMatchObject({ change: "replaced", replacesMerchantId: M.goldenHour });
      expect(byMerchant[M.swiftline]).toMatchObject({ change: "replaced", replacesMerchantId: M.pelican });
      expect(plan.basedOnRevision).toBe(1);
      expect(plan.changeSummary.kept).toEqual(["Bodega Marquez"]);
      expect(plan.changeSummary.replaced).toEqual([
        { from: "Golden Hour Taqueria", to: "Juniper & Rye Catering", why: "Supplier cancelled (simulated)" },
        { from: "Pelican Couriers", to: "Swiftline Runners", why: "previous selection no longer valid" },
      ]);
      expect(plan.changeSummary.widened).toBe("Keeping Pelican Couriers would exceed the budget by $22.14; Swiftline Runners replaces it.");
      expect(plan.reason).toBe("Fewest changes among 1 feasible of 25 evaluated: Bodega Marquez + Juniper & Rye Catering + Swiftline Runners.");
      expect(plan.evaluation.candidatesChecked).toBe(25); // five offers once Golden Hour is unavailable
      expect(plan.budget.remainingCents).toBe(100_000 - 99_414);
    });
  });
});

describe("buildPlan on the preset", () => {
  const plan = buildPlan({
    ctx: negotiated.ctx,
    result: negotiated.final,
    candidate: best,
    revision: 1,
    requestVersion: 1,
    createdAt: FIXED_NOW_ISO,
    readyByLocal: "18:30",
    latestArrivalLocal: "18:10",
    budgetCents: 100_000,
    sunk: { retainedCents: 0, pendingRefundCents: 0 },
  });

  it("satisfies the Plan contract", () => {
    const parsed = Plan.safeParse(plan);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  });

  it("reports totals, budget and schedule", () => {
    expect(plan).toMatchObject({ revision: 1, status: "proposed", requestVersion: 1, fullyPriced: true });
    expect(plan.totals).toEqual({ goodsCents: 71_240, feesCents: 0, deliveryCents: 7_200, totalCents: 78_440 });
    expect(plan.budget).toEqual({ budgetCents: 100_000, planCents: 78_440, retainedCents: 0, pendingRefundCents: 0, exposureCents: 78_440, remainingCents: 21_560 });
    expect(plan.schedule).toEqual({ readyByLocal: "18:30", latestArrivalLocal: "18:10", lastArrivalLocal: "17:50", slackMinutes: 20 });
    expect(plan.coverage.meal_vegetarian.supplied).toBeGreaterThanOrEqual(plan.coverage.meal_vegetarian.required);
  });

  it("marks every selection as added and gives the courier its pickups", () => {
    expect(plan.selections.every((s) => s.change === "added")).toBe(true);
    expect(plan.changeSummary).toEqual({ kept: [], added: [], removed: [], replaced: [] });
    const courier = must(plan.selections.find((s) => s.merchantId === M.pelican));
    expect(courier.deliversFor).toEqual([OFFER_IDS.bodega, OFFER_IDS.goldenHour]);
    const golden = must(plan.selections.find((s) => s.merchantId === M.goldenHour));
    expect(golden.coverage.meal_vegetarian).toBe(20);
    expect(golden.coverage.meal_standard).toBe(40);
  });
});

describe("explainInfeasibility", () => {
  it("explains the $500 budget variant as over_budget with the cheapest invalid option and its exact gap", () => {
    const req = interpretLocal(REQUESTS.impossibleBudget);
    expect(req.budgetCents).toBe(50_000);
    const m = runMarket({ requirements: req });
    expect(m.final.best).toBeNull();
    const inf = explainInfeasibility(m.ctx, m.final, groupsOpen(m.offers));
    expect(inf.kind).toBe("over_budget");
    const cheapest = must(inf.cheapestInvalid);
    expect(cheapest.merchants.sort()).toEqual([...NEG.bestMerchants].sort());
    expect(cheapest.failing).toEqual(["over_budget"]);
    expect(cheapest.totalCents).toBe(78_440);
    expect(cheapest.budgetGapCents).toBe(28_440); // $784.40 - $500.00
    expect(cheapest.budgetGapCents).toBe(cheapest.totalCents - m.demand.budgetCents);
    expect(inf.summary).toContain("284.40");
    // Independent check: the cheapest candidate that fails only on budget.
    const budgetOnly = m.final.candidates.filter((c) => c.rejects.length === 1 && c.rejects[0] === "over_budget").sort(compareFresh);
    expect(must(budgetOnly[0]).exposureCents).toBe(cheapest.totalCents);
    expect(inf.evaluation.candidatesChecked).toBe(41);
  });

  it("includes retained charges and pending refunds in the gap", () => {
    const m = runMarket({ sunkCents: 30_000 });
    expect(m.final.best).toBeNull();
    const inf = explainInfeasibility(m.ctx, m.final, groupsOpen(m.offers));
    expect(inf.kind).toBe("over_budget");
    expect(must(inf.cheapestInvalid).budgetGapCents).toBe(78_440 + 30_000 - 100_000);
    expect(inf.details.join(" ")).toContain("retained charges and pending refunds");
  });

  it("returns no_supply when every meal merchant is unavailable at quote time", () => {
    const availability = { [M.juniper]: { available: false }, [M.goldenHour]: { available: false }, [M.harbor]: { available: false } };
    const m = runMarket({ availability });
    expect(m.offers.some((o) => o.group === "meals")).toBe(false);
    expect(m.final.best).toBeNull();
    const inf = explainInfeasibility(m.ctx, m.final, groupsOpen(m.offers, m.availability));
    expect(inf.kind).toBe("no_supply");
    expect(inf.cheapestInvalid).toBeUndefined();
    expect(inf.details.join(" ")).toContain("No supply is invented");
  });

  it("returns no_supply when meal merchants go unavailable after quoting", () => {
    const availability = { [M.juniper]: { available: false }, [M.goldenHour]: { available: false }, [M.harbor]: { available: false } };
    const result = solve({ ...negotiated.ctx, availability });
    expect(result.best).toBeNull();
    for (const c of result.candidates.filter((x) => x.offers.some((o) => o.group === "meals"))) expect(c.rejects).toContain("merchant_unavailable");
    const inf = explainInfeasibility({ ...negotiated.ctx, availability }, result, groupsOpen(negotiated.offers, availability));
    expect(inf.kind).toBe("no_supply");
  });

  it("returns timing when every otherwise-valid combination misses the ready-by time", () => {
    const m = runMarket({ budgetCents: 200_000, readyByLocal: "17:30", rounds: 0 });
    expect(m.final.best).toBeNull();
    const inf = explainInfeasibility(m.ctx, m.final, groupsOpen(m.offers));
    expect(inf.kind).toBe("timing");
  });

  it("produces output that satisfies the Infeasibility contract", () => {
    const m = runMarket({ requirements: interpretLocal(REQUESTS.impossibleBudget) });
    const inf = explainInfeasibility(m.ctx, m.final, groupsOpen(m.offers));
    const parsed = Infeasibility.safeParse(inf);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  });
});

describe("evaluation counts and scope", () => {
  it("evaluates 41 candidates for the 6 offers quoted at round 0 (Harbor declines at 60)", () => {
    expect(initial.offers.length).toBe(NEG.offersQuoted);
    expect(Object.keys(initial.skipped)).toEqual([M.harbor]);
    expect(initial.skipped[M.harbor]).toBe(NEG.harborSkipReason);
    expect(initial.final.candidatesChecked).toBe(41);
    expect(initial.final.candidatesChecked).toBe(choose(6, 1) + choose(6, 2) + choose(6, 3));
  });

  it("keeps 41 candidates and grows the feasible count 0 -> 3 -> 4 across the rounds", () => {
    expect(negotiated.solves.map((s) => s.candidatesChecked)).toEqual([...NEG.checkedPerRound]);
    expect(negotiated.solves.map((s) => s.feasibleCandidates)).toEqual([...NEG.feasiblePerRound]);
  });

  it("counts rejection reasons per candidate before and after negotiation", () => {
    expect(initial.final.rejectedByReason).toEqual({
      dietary_shortfall: 14,
      incomplete_coverage: 25,
      needs_delivery: 11,
      arrival_too_late: 16,
      over_budget: 12,
      pickup_too_late: 5,
      courier_capacity: 1,
      delivery_unused: 13,
    });
    expect(negotiated.final.rejectedByReason).toEqual({
      dietary_shortfall: 14,
      incomplete_coverage: 25,
      needs_delivery: 11,
      over_budget: 10,
      courier_capacity: 1,
      delivery_unused: 13,
    });
    expect(negotiated.final.solverMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(negotiated.final.solverMs)).toBe(true);
  });

  it("bounds the candidate size with maxOffersPerCandidate", () => {
    expect(solve({ ...initial.ctx, maxOffersPerCandidate: 1 }).candidatesChecked).toBe(6);
    expect(solve({ ...initial.ctx, maxOffersPerCandidate: 2 }).candidatesChecked).toBe(6 + 15);
  });

  it("labels every plan 'optimal among evaluated candidates only'", () => {
    const plan = buildPlan({ ctx: negotiated.ctx, result: negotiated.final, candidate: best, revision: 1, requestVersion: 1, createdAt: FIXED_NOW_ISO, readyByLocal: "18:30", latestArrivalLocal: "18:10", budgetCents: 100_000, sunk: { retainedCents: 0, pendingRefundCents: 0 } });
    expect(plan.evaluation.scope).toBe("optimal among evaluated candidates only");
    expect(plan.evaluation.candidatesChecked).toBe(41);
    expect(plan.evaluation.feasibleCandidates).toBe(4);
    expect(plan.evaluation.rejectedByReason.dietary_shortfall).toBe(14);
    expect(plan.evaluation.rejectedByReason.offer_expired).toBe(0); // contract-complete: reasons that never fired report 0
    expect(plan.reason).toBe("Lowest all-in cost among 4 feasible of 41 evaluated: Bodega Marquez + Golden Hour Taqueria + Pelican Couriers.");
  });

  it("limits near misses to candidates that fail only on negotiable constraints", () => {
    const misses = nearMisses(initial.final);
    expect(misses.length).toBeGreaterThan(0);
    const fixable = new Set(["over_budget", "arrival_too_late", "pickup_too_late"]);
    for (const c of misses) {
      expect(c.feasible).toBe(false);
      expect(c.rejects.every((r) => fixable.has(r))).toBe(true);
    }
    expect([...misses].sort(compareFresh)).toEqual(misses);
    expect(nearMisses(negotiated.final).every((c) => !c.feasible)).toBe(true);
  });

  it("sums supplied quantities across offers", () => {
    expect(supplied(best.offers)).toEqual({ meal_vegetarian: 20, meal_standard: 40, drink_serving: 60, plate: 60, utensil_set: 60, delivery_run: 1 });
  });
});
