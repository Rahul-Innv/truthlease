import { describe, expect, it } from "vitest";
import { MAX_REQUESTS_PER_ROUND, MAX_ROUNDS, planRound, type CounterRequest } from "../src/lib/buyer";
import { CATALOG } from "../src/lib/catalog";
import { Offer, type NegotiationLever } from "../src/lib/contracts";
import { EXPECTED, EXPECTED_PRESET_NEGOTIATION as NEG, FIXED_NOW_ISO, MERCHANT_IDS as M, OFFER_IDS } from "../src/lib/fixtures";
import { delayOffer, OFFER_TTL_MS, quote, respond, type ConcessionResult } from "../src/lib/seller";
import { deriveDemand, explainInfeasibility, solve, type SolveResult } from "../src/lib/solver";
import {
  atOffset,
  catalogMerchant,
  groupsOpen,
  must,
  presetRequirements,
  qctxFor,
  quoteOffer,
  runMarket,
  tweakMerchant,
  type RequirementOverrides,
} from "./helpers";

const demandFor = (o: RequirementOverrides = {}) => deriveDemand(presetRequirements(o));
const preset = demandFor();

function expectRevised(r: ConcessionResult): { offer: Offer; reply: string } {
  if (r.outcome !== "revised") throw new Error(`Expected a revision, got a decline: ${r.reply}`);
  return r;
}
function expectDeclined(r: ConcessionResult): string {
  if (r.outcome !== "declined") throw new Error(`Expected a decline, got revision r${r.offer.revision}`);
  return r.reply;
}
/** Ask a freshly quoted catalog merchant for a lever. */
function ask(merchantId: string, lever: NegotiationLever, opts: { round?: number; demand?: ReturnType<typeof demandFor> } = {}) {
  const demand = opts.demand ?? preset;
  const m = catalogMerchant(merchantId);
  return respond(m, quoteOffer(merchantId, demand), lever, opts.round ?? 1, qctxFor(demand));
}
const unitFloor = (listCents: number, floorPct: number) => Math.ceil((listCents * floorPct) / 100);

describe("seller.quote", () => {
  it("skips Harbor Kitchen at 60 attendees because of its 75-meal minimum order", () => {
    const r = quote(catalogMerchant(M.harbor), qctxFor(preset));
    expect(r).toEqual({ kind: "skip", reason: NEG.harborSkipReason });
  });

  it("quotes Harbor exactly at its minimum order, and skips one below", () => {
    expect(quote(catalogMerchant(M.harbor), qctxFor(demandFor({ headcount: 74 }))).kind).toBe("skip");
    const at = quote(catalogMerchant(M.harbor), qctxFor(demandFor({ headcount: 75 })));
    expect(at.kind).toBe("offer");
  });

  it("quotes a partial offer when the headcount exceeds its capacity (supply assembly)", () => {
    const d85 = demandFor({ headcount: 85 });
    const golden = quote(catalogMerchant(M.goldenHour), qctxFor(d85));
    expect(golden.kind).toBe("offer");
    if (golden.kind === "offer") {
      expect(golden.offer.partial).toEqual({ coversMeals: 70, ofMeals: 85 });
      expect(golden.offer.lines.reduce((s, l) => s + l.qty, 0)).toBe(70);
      expect(golden.offer.conditions.some((c) => /Partial: covers 70 of 85/.test(c))).toBe(true);
    }
    expect(quote(catalogMerchant(M.juniper), qctxFor(d85)).kind).toBe("offer"); // capacity 90, full quote
    const full = quote(catalogMerchant(M.goldenHour), qctxFor(demandFor({ headcount: 70 })));
    expect(full.kind).toBe("offer");
    if (full.kind === "offer") expect(full.offer.partial).toBeUndefined(); // exactly at capacity
    const d130 = demandFor({ headcount: 130 });
    for (const m of CATALOG.filter((x) => x.group === "meals")) {
      const q = quote(m, qctxFor(d130));
      expect(q.kind).toBe("offer");
      if (q.kind === "offer") expect(q.offer.partial?.coversMeals).toBe(m.capacity.maxMeals);
    }
    // Below a kitchen's minimum order it still declines rather than quoting.
    expect(quote(catalogMerchant(M.harbor), qctxFor(demandFor({ headcount: 60 }))).kind).toBe("skip");
  });

  it("skips a drinks merchant when servings exceed its capacity", () => {
    expect(quote(catalogMerchant(M.bodega), qctxFor(demandFor({ headcount: 151 }))).kind).toBe("skip"); // capacity 150
    expect(quote(catalogMerchant(M.bodega), qctxFor(demandFor({ headcount: 150 }))).kind).toBe("offer");
    expect(quote(catalogMerchant(M.fogline), qctxFor(demandFor({ headcount: 201 }))).kind).toBe("skip"); // capacity 200
  });

  it("quotes the exact vegetarian / standard split at catalog prices", () => {
    const o = quoteOffer(M.juniper, preset);
    expect(o.lines).toEqual([
      { sku: "veg-bowl", label: "Roasted vegetable grain bowl (vegetarian)", kind: "meal_vegetarian", qty: 20, unitCents: 1250, lineCents: 25_000 },
      { sku: "std-box", label: "Herb chicken dinner box", kind: "meal_standard", qty: 40, unitCents: 1350, lineCents: 54_000 },
    ]);
  });

  it("omits the vegetarian line at 0 vegetarian and the standard line when everyone is vegetarian", () => {
    const none = quoteOffer(M.juniper, demandFor({ vegetarianMin: 0 }));
    expect(none.lines.map((l) => [l.kind, l.qty])).toEqual([["meal_standard", 60]]);
    const all = quoteOffer(M.juniper, demandFor({ vegetarianMin: 60 }));
    expect(all.lines.map((l) => [l.kind, l.qty])).toEqual([["meal_vegetarian", 60]]);
  });

  it("applies the seller's minimum quantity and charges for the oversupply", () => {
    const o = quoteOffer(M.fogline, demandFor({ headcount: 30, vegetarianMin: 10 }));
    const drink = must(o.lines.find((l) => l.kind === "drink_serving"));
    expect(drink.qty).toBe(40); // Fogline sells at least 40 drink servings
    expect(must(o.lines.find((l) => l.kind === "plate")).qty).toBe(30);
    expect(o.totalCents).toBe(40 * 210 + 30 * 45 + 30 * 35 + 2500);
  });

  it("computes the service fee as a rounded percentage of goods", () => {
    const juniper = quoteOffer(M.juniper, preset);
    expect(juniper.fees).toEqual([{ label: "Service fee (5%)", cents: 3950 }]); // 5% of $790.00

    const d76 = demandFor({ headcount: 76 });
    const goods = 20 * 995 + 56 * 1045; // 78,420
    const harbor = quoteOffer(M.harbor, d76);
    expect(harbor.fees).toEqual([{ label: "Service fee (8%)", cents: Math.round(goods * 0.08) }]);
    expect(harbor.fees[0]?.cents).toBe(6274); // 6,273.6 rounds half up
    expect(harbor.totalCents).toBe(goods + 6274);

    expect(quoteOffer(M.goldenHour, preset).fees).toEqual([]); // 0% fee: no fee line at all
  });

  it("adds an included-delivery fee to the total and records a null delivery for pickup-only offers", () => {
    const juniper = quoteOffer(M.juniper, preset);
    expect(juniper.deliveryCents).toBe(4000);
    expect(juniper.totalCents).toBe(79_000 + 3950 + 4000);
    expect(juniper.fulfillment).toMatchObject({ mode: "included_delivery", slotId: "arr-1745", timeLocal: "17:45" });

    const harbor = quoteOffer(M.harbor, demandFor({ headcount: 85 }));
    expect(harbor.deliveryCents).toBe(0); // free delivery is explicit, not missing
    expect(harbor.conditions).toContain("Delivery included in quoted prices.");

    const golden = quoteOffer(M.goldenHour, preset);
    expect(golden.deliveryCents).toBeNull();
    expect(golden.conditions).toContain("Pickup only: a courier must collect the order.");
    expect(golden.fulfillment).toMatchObject({ mode: "pickup_only", timeLocal: "17:30" });

    const pelican = quoteOffer(M.pelican, preset);
    expect(pelican.deliveryCents).toBeNull(); // the courier's price is its delivery_run line
    expect(pelican.lines).toEqual([{ sku: "route-2", label: "Event run, up to 2 pickups", kind: "delivery_run", qty: 1, unitCents: 7200, lineCents: 7200 }]);
    expect(pelican.totalCents).toBe(7200);
    expect(pelican.fulfillment).toMatchObject({ mode: "courier", timeLocal: "17:50", pickupByLocal: "17:15", maxPickups: 2 });
  });

  it("declines outside its service zone, when lead time cannot meet the slot, and when nothing is asked of it", () => {
    expect(quote(catalogMerchant(M.bodega), qctxFor({ ...preset, zone: "mission" }))).toEqual({ kind: "skip", reason: 'Does not serve zone "mission"' });
    const late = demandFor({ nowLocal: "16:00" }); // Juniper needs 180 minutes before 5:45 PM
    expect(quote(catalogMerchant(M.juniper), qctxFor(late))).toEqual({ kind: "skip", reason: "Lead time 180 min cannot meet Arrive 5:45 PM" });
    const noConsumables = demandFor({ items: { drinks: false, plates: false, utensils: false } });
    expect(quote(catalogMerchant(M.fogline), qctxFor(noConsumables))).toEqual({ kind: "skip", reason: "No drinks or consumables requested" });
    expect(quote(catalogMerchant(M.pelican), qctxFor(noConsumables)).kind).toBe("offer"); // couriers are unaffected
  });

  it("stamps identity, validity and provenance on every offer and satisfies the Offer contract", () => {
    const d = preset;
    for (const m of CATALOG) {
      const r = quote(m, qctxFor(d, { requestVersion: 2, reasoning: "live" }));
      if (r.kind !== "offer") continue;
      const o = r.offer;
      expect(Offer.safeParse(o).success).toBe(true);
      expect(o.id).toBe(`off_${m.id.replace(/^m-/, "")}_v2`);
      expect(o).toMatchObject({ revision: 1, status: "open", requestVersion: 2, unpriced: [], createdAt: FIXED_NOW_ISO });
      expect(o.supersedesRevision).toBeUndefined();
      expect(o.expiresAt).toBe(atOffset(OFFER_TTL_MS));
      expect(o.provenance).toMatchObject({ supply: "demo_catalog", reasoning: "live", round: 0 });
      expect(o.totalCents).toBe(o.lines.reduce((s, l) => s + l.lineCents, 0) + o.fees.reduce((s, f) => s + f.cents, 0) + (o.deliveryCents ?? 0));
    }
  });

  it("is deterministic", () => {
    expect(quote(catalogMerchant(M.juniper), qctxFor(preset))).toEqual(quote(catalogMerchant(M.juniper), qctxFor(preset)));
  });
});

describe("seller.respond: volume_discount", () => {
  it("applies the 8% tier to Juniper at 60 meals and reprices every line, fee and total", () => {
    const { offer, reply } = expectRevised(ask(M.juniper, "volume_discount"));
    expect(reply).toBe("Applied a 8% volume discount for 60 units.");
    expect(offer.lines.map((l) => [l.kind, l.unitCents, l.lineCents])).toEqual([
      ["meal_vegetarian", 1150, 23_000],
      ["meal_standard", 1242, 49_680],
    ]);
    expect(offer.fees).toEqual([{ label: "Service fee (5%)", cents: 3634 }]); // 5% of $726.80
    expect(offer.totalCents).toBe(NEG.juniper.volumeTotalCents);
    expect(offer.totalCents).toBe(72_680 + 3634 + 4000);
    expect(offer.provenance).toMatchObject({ round: 1, note: "Applied 8% volume discount at ≥50 units" });
  });

  it("never prices a unit below ceil(list * floorPctOfList / 100), for every catalog merchant and quantity", () => {
    let revisions = 0;
    for (const m of CATALOG.filter((x) => x.policy.volumeDiscount.length > 0)) {
      for (const headcount of [20, 30, 45, 50, 60, 70, 75, 80, 85, 90, 100, 120]) {
        const d = demandFor({ headcount, vegetarianMin: Math.min(20, headcount) });
        const q = quote(m, qctxFor(d));
        if (q.kind !== "offer") continue;
        const r = respond(m, q.offer, "volume_discount", 1, qctxFor(d));
        if (r.outcome !== "revised") continue;
        revisions += 1;
        for (const line of r.offer.lines) {
          const item = must(m.catalog.find((c) => c.sku === line.sku));
          expect(line.unitCents).toBeGreaterThanOrEqual(unitFloor(item.unitCents, m.policy.floorPctOfList));
          expect(line.unitCents).toBeLessThanOrEqual(item.unitCents);
          expect(line.lineCents).toBe(line.unitCents * line.qty);
        }
      }
    }
    expect(revisions).toBeGreaterThanOrEqual(8); // the loop must actually exercise discounts
  });

  it("clamps to the floor when the tier would undercut it", () => {
    const m = tweakMerchant(M.juniper, { policy: { floorPctOfList: 97, volumeDiscount: [{ minQty: 50, pct: 20 }] } });
    const { offer } = expectRevised(respond(m, quoteOffer(M.juniper, preset), "volume_discount", 1, qctxFor(preset)));
    expect(offer.lines.map((l) => l.unitCents)).toEqual([unitFloor(1250, 97), unitFloor(1350, 97)]); // 1213, 1310
    expect(offer.lines.map((l) => l.unitCents)).toEqual([1213, 1310]);
  });

  it("picks the highest tier whose minimum quantity is met", () => {
    const m = tweakMerchant(M.juniper, { policy: { volumeDiscount: [{ minQty: 30, pct: 3 }, { minQty: 60, pct: 7 }] } });
    const at60 = expectRevised(respond(m, quoteOffer(M.juniper, preset), "volume_discount", 1, qctxFor(preset)));
    expect(at60.reply).toBe("Applied a 7% volume discount for 60 units.");
    expect(at60.offer.lines[0]?.unitCents).toBe(Math.round(1250 * 0.93));
    const d45 = demandFor({ headcount: 45 });
    const at45 = expectRevised(respond(m, quoteOffer(M.juniper, d45), "volume_discount", 1, qctxFor(d45)));
    expect(at45.reply).toBe("Applied a 3% volume discount for 45 units.");
  });

  it("declines below the first tier and says where volume pricing starts", () => {
    const d40 = demandFor({ headcount: 40, vegetarianMin: 10 });
    expect(expectDeclined(ask(M.juniper, "volume_discount", { demand: d40 }))).toBe("Volume pricing starts at 50 units.");
    // Golden Hour: tier at 60. 59 is declined, 60 is accepted.
    expect(expectDeclined(ask(M.goldenHour, "volume_discount", { demand: demandFor({ headcount: 59 }) }))).toBe("Volume pricing starts at 60 units.");
    expect(ask(M.goldenHour, "volume_discount", { demand: demandFor({ headcount: 60 }) }).outcome).toBe("revised");
    // Fogline counts drink servings only: 60 < 80.
    expect(expectDeclined(ask(M.fogline, "volume_discount"))).toBe("Volume pricing starts at 80 units.");
    expect(ask(M.fogline, "volume_discount", { demand: demandFor({ headcount: 80 }) }).outcome).toBe("revised");
  });

  it("declines merchants with fixed pricing", () => {
    for (const id of [M.bodega, M.pelican, M.swiftline]) {
      expect(expectDeclined(ask(id, "volume_discount"))).toBe("Fixed pricing; no volume discount available.");
    }
  });

  it("declines a second request once the best volume price is already applied", () => {
    const m = catalogMerchant(M.goldenHour);
    const first = expectRevised(respond(m, quoteOffer(M.goldenHour, preset), "volume_discount", 1, qctxFor(preset)));
    expect(expectDeclined(respond(m, first.offer, "volume_discount", 2, qctxFor(preset)))).toBe("Already at the best available volume price.");
  });

  it("keeps the current slot when it applies a volume discount", () => {
    const m = catalogMerchant(M.goldenHour);
    const early = expectRevised(respond(m, quoteOffer(M.goldenHour, preset), "earlier_slot", 1, qctxFor(preset)));
    const priced = expectRevised(respond(m, early.offer, "volume_discount", 1, qctxFor(preset)));
    expect(priced.offer.fulfillment.timeLocal).toBe("17:00");
    expect(priced.offer.fulfillment.slotId).toBe("ready-1700");
  });
});

describe("seller.respond: earlier_slot", () => {
  it("moves Golden Hour from 5:30 PM to 5:00 PM at the same price", () => {
    const list = quoteOffer(M.goldenHour, preset);
    const { offer, reply } = expectRevised(ask(M.goldenHour, "earlier_slot"));
    expect(reply).toBe("Moved to Ready 5:00 PM.");
    expect(offer.fulfillment).toMatchObject({ slotId: "ready-1700", timeLocal: "17:00" });
    expect(offer.totalCents).toBe(list.totalCents);
    expect(offer.totalCents).toBe(NEG.goldenHour.earlierSlotTotalCents);
  });

  it("moves Fogline from 6:15 PM to 4:30 PM", () => {
    const { offer } = expectRevised(ask(M.fogline, "earlier_slot"));
    expect(offer.fulfillment).toMatchObject({ slotId: "arr-1630", timeLocal: NEG.fogline.arrivalLocal });
    expect(offer.totalCents).toBe(NEG.fogline.earlierSlotTotalCents);
  });

  it("respects lead time: the earlier window is allowed exactly at now + lead time, and refused after", () => {
    // Golden Hour: lead time 120 min, earlier window 17:00 => latest allowed 'now' is 15:00.
    expect(ask(M.goldenHour, "earlier_slot", { demand: demandFor({ nowLocal: "15:00" }) }).outcome).toBe("revised");
    expect(expectDeclined(ask(M.goldenHour, "earlier_slot", { demand: demandFor({ nowLocal: "15:01" }) }))).toBe("No earlier window; lead time is 120 min.");
    // Fogline: lead time 90 min, earlier window 16:30 => latest 'now' is 15:00.
    expect(ask(M.fogline, "earlier_slot", { demand: demandFor({ nowLocal: "15:00" }) }).outcome).toBe("revised");
    expect(expectDeclined(ask(M.fogline, "earlier_slot", { demand: demandFor({ nowLocal: "15:01" }) }))).toBe("No earlier window; lead time is 90 min.");
  });

  it("declines when the seller is not slot-flexible", () => {
    expect(catalogMerchant(M.bodega).policy.slotFlexible).toBe(false);
    expect(expectDeclined(ask(M.bodega, "earlier_slot"))).toBe("Only one time window is available.");
    expect(expectDeclined(ask(M.swiftline, "earlier_slot"))).toBe("Only one time window is available.");
  });

  it("declines when it is already on its earliest window", () => {
    const m = catalogMerchant(M.goldenHour);
    const first = expectRevised(respond(m, quoteOffer(M.goldenHour, preset), "earlier_slot", 1, qctxFor(preset)));
    expect(expectDeclined(respond(m, first.offer, "earlier_slot", 2, qctxFor(preset)))).toBe("No earlier window; lead time is 120 min.");
    // Juniper's default slot (5:45 PM) is already earlier than its only alternative (6:00 PM).
    expect(ask(M.juniper, "earlier_slot").outcome).toBe("declined");
  });

  it("keeps an already applied volume discount when it re-slots", () => {
    const m = catalogMerchant(M.goldenHour);
    const priced = expectRevised(respond(m, quoteOffer(M.goldenHour, preset), "volume_discount", 1, qctxFor(preset)));
    const moved = expectRevised(respond(m, priced.offer, "earlier_slot", 2, qctxFor(preset)));
    expect(moved.offer.totalCents).toBe(NEG.goldenHour.volumeTotalCents);
    expect(moved.offer.fulfillment.timeLocal).toBe("17:00");
  });
});

describe("seller.respond: later_pickup", () => {
  it("lets a courier move to a later pickup window at the same price", () => {
    const { offer, reply } = expectRevised(ask(M.pelican, "later_pickup"));
    expect(reply).toBe("Moved to Arrive 6:05 PM (pickups by 5:30 PM).");
    expect(offer.fulfillment).toMatchObject({ slotId: "run-1805", timeLocal: "18:05", pickupByLocal: "17:30", maxPickups: 2 });
    expect(offer.totalCents).toBe(7200);
  });

  it("declines a second request when no later window remains", () => {
    const m = catalogMerchant(M.pelican);
    const first = expectRevised(respond(m, quoteOffer(M.pelican, preset), "later_pickup", 1, qctxFor(preset)));
    expect(expectDeclined(respond(m, first.offer, "later_pickup", 2, qctxFor(preset)))).toBe("No later pickup window available.");
  });

  it("is only available from couriers", () => {
    for (const id of [M.goldenHour, M.bodega, M.juniper, M.fogline]) {
      expect(expectDeclined(ask(id, "later_pickup"))).toBe("Not a courier offer.");
    }
  });

  it("declines when the courier is not slot-flexible", () => {
    expect(expectDeclined(ask(M.swiftline, "later_pickup"))).toBe("Only one run time is available.");
  });
});

describe("seller.respond: rounds and revisions", () => {
  it("stops negotiating past maxRounds, even for a request it would otherwise grant", () => {
    const m = tweakMerchant(M.goldenHour, { policy: { maxRounds: 1 } });
    const offer = quoteOffer(M.goldenHour, preset);
    expect(respond(m, offer, "volume_discount", 1, qctxFor(preset)).outcome).toBe("revised");
    expect(expectDeclined(respond(m, offer, "volume_discount", 2, qctxFor(preset)))).toBe("Not negotiating further on this request.");
    // Catalog sellers with maxRounds 1.
    expect(catalogMerchant(M.bodega).policy.maxRounds).toBe(1);
    expect(expectDeclined(respond(catalogMerchant(M.swiftline), quoteOffer(M.swiftline, preset), "earlier_slot", 2, qctxFor(preset)))).toBe("Not negotiating further on this request.");
    expect(expectDeclined(respond(catalogMerchant(M.bodega), quoteOffer(M.bodega, preset), "volume_discount", 2, qctxFor(preset)))).toBe("Not negotiating further on this request.");
  });

  it("does not negotiate at all when maxRounds is 0", () => {
    const m = tweakMerchant(M.juniper, { policy: { maxRounds: 0 } });
    expect(expectDeclined(respond(m, quoteOffer(M.juniper, preset), "volume_discount", 1, qctxFor(preset)))).toBe("Not negotiating further on this request.");
  });

  it("supersedes: each accepted lever yields the next revision of the same offer id", () => {
    const m = catalogMerchant(M.goldenHour);
    const r1 = quoteOffer(M.goldenHour, preset);
    const r2 = expectRevised(respond(m, r1, "earlier_slot", 1, qctxFor(preset))).offer;
    const r3 = expectRevised(respond(m, r2, "volume_discount", 1, qctxFor(preset))).offer;
    expect([r1.revision, r2.revision, r3.revision]).toEqual([1, 2, 3]);
    expect(r1.supersedesRevision).toBeUndefined();
    expect(r2.supersedesRevision).toBe(1);
    expect(r3.supersedesRevision).toBe(2);
    expect(new Set([r1.id, r2.id, r3.id]).size).toBe(1);
    expect(r3.status).toBe("open");
    expect(r3.provenance.round).toBe(1);
    for (const o of [r1, r2, r3]) expect(Offer.safeParse(o).success).toBe(true);
  });

  it("does not mutate the offer it was given", () => {
    const m = catalogMerchant(M.juniper);
    const before = quoteOffer(M.juniper, preset);
    const snapshot = structuredClone(before);
    respond(m, before, "volume_discount", 1, qctxFor(preset));
    expect(before).toEqual(snapshot);
  });

  it("stamps revisions with the response context's timestamp and request version", () => {
    const m = catalogMerchant(M.goldenHour);
    const r2 = expectRevised(respond(m, quoteOffer(M.goldenHour, preset), "earlier_slot", 1, qctxFor(preset, { nowIso: atOffset(60_000) }))).offer;
    expect(r2.createdAt).toBe(atOffset(60_000));
    expect(r2.expiresAt).toBe(atOffset(60_000 + OFFER_TTL_MS));
  });
});

describe("seller.delayOffer", () => {
  it("moves the arrival later and creates a superseding revision with the same prices", () => {
    const pelican = quoteOffer(M.pelican, preset);
    const snapshot = structuredClone(pelican);
    const delayed = delayOffer(pelican, 25, atOffset(120_000));
    expect(delayed.fulfillment.timeLocal).toBe("18:15"); // 17:50 + 25
    expect(delayed).toMatchObject({ id: pelican.id, revision: 2, supersedesRevision: 1, totalCents: pelican.totalCents, status: "open", createdAt: atOffset(120_000) });
    expect(delayed.lines).toEqual(pelican.lines);
    expect(delayed.conditions).toContain("Supplier reported a 25-minute delay.");
    expect(delayed.provenance.note).toBe("Delayed 25 min by supplier");
    expect(pelican).toEqual(snapshot);
    expect(Offer.safeParse(delayed).success).toBe(true);
  });

  it("caps conditions at ten and clamps the arrival to the end of the day", () => {
    const pelican = quoteOffer(M.pelican, preset);
    const crowded = { ...pelican, conditions: Array.from({ length: 10 }, (_, i) => `Condition ${i}`) };
    const delayed = delayOffer(crowded, 240, FIXED_NOW_ISO);
    expect(delayed.conditions).toHaveLength(10);
    const veryLate = delayOffer({ ...pelican, fulfillment: { ...pelican.fulfillment, timeLocal: "23:30" } }, 240, FIXED_NOW_ISO);
    expect(veryLate.fulfillment.timeLocal).toBe("23:59");
  });
});

describe("buyer.planRound", () => {
  const initial = runMarket({ rounds: 0 });
  const round0 = must(initial.solves[0]);
  const key = (r: CounterRequest) => `${r.offerId}:${r.lever}`;

  it("exposes its caps", () => {
    expect(MAX_REQUESTS_PER_ROUND).toBe(6);
    expect(MAX_ROUNDS).toBe(2);
  });

  it("asks the late arriver for an earlier_slot when a candidate fails on arrival_too_late", () => {
    const plan = planRound(round0, initial.demand, 1, new Set(), initial.offers);
    const fogline = must(plan.requests.find((r) => r.offerId === OFFER_IDS.fogline && r.lever === "earlier_slot"));
    expect(fogline.merchantId).toBe(M.fogline);
    expect(fogline.ask).toBe("Arrival 18:15 is after the latest arrival; please move earlier.");
  });

  it("asks a courier that would arrive late for an earlier_slot too", () => {
    const pelican = initial.latest(M.pelican);
    const late = delayOffer(pelican, 30, FIXED_NOW_ISO); // 18:20 > 18:10
    const offers = [...initial.offers.map((o) => (o.id === pelican.id ? { ...o, status: "superseded" as const } : o)), late];
    const result = solve({ ...initial.ctx, offers });
    const plan = planRound(result, initial.demand, 1, new Set(), offers);
    expect(plan.requests).toContainEqual(expect.objectContaining({ offerId: pelican.id, merchantId: M.pelican, lever: "earlier_slot" }));
  });

  it("round 1 asks the pickup supplier to be ready earlier; it does not ask the courier yet", () => {
    const plan = planRound(round0, initial.demand, 1, new Set(), initial.offers);
    const golden = must(plan.requests.find((r) => r.offerId === OFFER_IDS.goldenHour && r.lever === "earlier_slot"));
    expect(golden.ask).toBe("Ready 17:30 misses the courier pickup window; can it be earlier?");
    expect(plan.requests.some((r) => r.lever === "later_pickup")).toBe(false);
  });

  it("round 2 asks the courier for a later_pickup window instead of the pickup supplier", () => {
    const plan = planRound(round0, initial.demand, 2, new Set(), initial.offers);
    const courier = must(plan.requests.find((r) => r.lever === "later_pickup"));
    expect(courier).toMatchObject({ offerId: OFFER_IDS.pelican, merchantId: M.pelican, ask: "Pickup at 17:30 needs a later collection window." });
    expect(plan.requests.some((r) => r.offerId === OFFER_IDS.goldenHour && r.lever === "earlier_slot")).toBe(false);
  });

  it("asks for volume_discount only from the two largest non-courier tickets of each shortlisted candidate", () => {
    const plan = planRound(round0, initial.demand, 1, new Set(), initial.offers);
    const volume = plan.requests.filter((r) => r.lever === "volume_discount").map((r) => r.merchantId).sort();
    expect(volume).toEqual([M.bodega, M.fogline, M.goldenHour].sort());
    expect(volume).not.toContain(M.pelican);
    expect(volume).not.toContain(M.swiftline);

    // A handcrafted feasible candidate with three non-courier offers: only the two largest are asked.
    const [juniper, fogline, bodega] = [initial.latest(M.juniper), initial.latest(M.fogline), initial.latest(M.bodega)];
    const result: SolveResult = {
      ...round0,
      candidates: [{ ...must(round0.candidates[0]), offers: [bodega, fogline, juniper], feasible: true, rejects: [] }],
    };
    const crafted = planRound(result, initial.demand, 1, new Set(), initial.offers);
    expect(crafted.requests.map(key)).toEqual([`${OFFER_IDS.juniper}:volume_discount`, `${OFFER_IDS.fogline}:volume_discount`]);
  });

  it("never repeats an (offer, lever) pair that was already asked", () => {
    const first = planRound(round0, initial.demand, 1, new Set(), initial.offers);
    const asked = new Set(first.requests.map(key));
    expect(asked.size).toBe(first.requests.length); // no duplicates within a round either
    expect(planRound(round0, initial.demand, 1, asked, initial.offers).requests).toEqual([]);
    const next = planRound(round0, initial.demand, 2, asked, initial.offers);
    for (const r of next.requests) expect(asked.has(key(r))).toBe(false);
  });

  it("skips offers that are no longer open", () => {
    const offers = initial.offers.map((o) => (o.id === OFFER_IDS.fogline ? { ...o, status: "withdrawn" as const } : o));
    const plan = planRound(round0, initial.demand, 1, new Set(), offers);
    expect(plan.requests.some((r) => r.offerId === OFFER_IDS.fogline)).toBe(false);
    expect(plan.requests.length).toBeGreaterThan(0);
  });

  it("caps a round at 6 requests even when more asks are available", () => {
    const clone = (id: string, newId: string, name: string) => tweakMerchant(id, { id: newId, name });
    const merchants = [
      ...CATALOG,
      clone(M.goldenHour, "m-goldenhour-b", "Golden Hour Two"),
      clone(M.goldenHour, "m-goldenhour-c", "Golden Hour Three"),
      clone(M.bodega, "m-bodega-b", "Bodega Two"),
      clone(M.fogline, "m-fogline-b", "Fogline Two"),
    ];
    const crowded = runMarket({ merchants, rounds: 0 });
    const result = must(crowded.solves[0]);
    const plan = planRound(result, crowded.demand, 1, new Set(), crowded.offers);
    expect(plan.requests).toHaveLength(MAX_REQUESTS_PER_ROUND);
    // The cap truncated the list: asking again with those six excluded still finds more.
    const rest = planRound(result, crowded.demand, 1, new Set(plan.requests.map(key)), crowded.offers);
    expect(rest.requests.length).toBeGreaterThan(0);
  });

  it("shortlists at most 2 feasible and 3 near-miss combinations, named by merchant", () => {
    const plan = planRound(round0, initial.demand, 1, new Set(), initial.offers);
    expect(plan.shortlist).toEqual([
      "Bodega Marquez + Golden Hour Taqueria + Pelican Couriers",
      "Fogline Beverage Co. + Golden Hour Taqueria + Swiftline Runners",
      "Fogline Beverage Co. + Golden Hour Taqueria + Pelican Couriers",
    ]);
    const negotiated = runMarket();
    const later = planRound(negotiated.final, negotiated.demand, 2, new Set(), negotiated.offers);
    expect(later.shortlist.length).toBeLessThanOrEqual(5);
  });

  it("asks for nothing when there is no feasible or near-miss combination to improve", () => {
    const none = runMarket({ availability: { [M.juniper]: { available: false }, [M.goldenHour]: { available: false }, [M.harbor]: { available: false } }, rounds: 0 });
    const plan = planRound(must(none.solves[0]), none.demand, 1, new Set(), none.offers);
    expect(plan).toEqual({ requests: [], shortlist: [] });
  });
});

describe("two-round negotiation on the preset reproduces the simulate.ts transcript", () => {
  const m = runMarket();
  const t = (round: number, merchantId: string, lever: NegotiationLever) =>
    must(m.transcript.find((e) => e.round === round && e.request.merchantId === merchantId && e.request.lever === lever), `${merchantId} ${lever} in round ${round}`);

  it("asks 5 things in round 1 and 1 thing in round 2, in order", () => {
    expect(m.transcript.map((e) => `${e.round}:${e.request.offerId}:${e.request.lever}:${e.outcome}`)).toEqual([
      `1:${OFFER_IDS.goldenHour}:earlier_slot:revised`,
      `1:${OFFER_IDS.goldenHour}:volume_discount:revised`,
      `1:${OFFER_IDS.bodega}:volume_discount:declined`,
      `1:${OFFER_IDS.fogline}:earlier_slot:revised`,
      `1:${OFFER_IDS.fogline}:volume_discount:declined`,
      `2:${OFFER_IDS.juniper}:volume_discount:revised`,
    ]);
    expect(m.roundPlans.map((p) => p.requests.length)).toEqual([5, 1]);
  });

  it("moves Golden Hour to 5:00 PM and then prices it at $565.40", () => {
    const slot = t(1, M.goldenHour, "earlier_slot").offer;
    expect(slot).toMatchObject({ revision: NEG.goldenHour.earlierSlotRevision, totalCents: NEG.goldenHour.earlierSlotTotalCents });
    expect(slot?.fulfillment.timeLocal).toBe(NEG.goldenHour.readyLocal);
    const vol = t(1, M.goldenHour, "volume_discount").offer;
    expect(vol).toMatchObject({ revision: NEG.goldenHour.volumeRevision, totalCents: NEG.goldenHour.volumeTotalCents, supersedesRevision: 2 });
    expect(vol?.totalCents).toBe(56_540);
    expect(vol?.fulfillment.timeLocal).toBe("17:00");
  });

  it("moves Fogline to 4:30 PM and declines its volume request", () => {
    expect(t(1, M.fogline, "earlier_slot").offer).toMatchObject({ revision: 2, totalCents: NEG.fogline.earlierSlotTotalCents });
    expect(t(1, M.fogline, "earlier_slot").offer?.fulfillment.timeLocal).toBe("16:30");
    expect(t(1, M.fogline, "volume_discount")).toMatchObject({ outcome: "declined", reply: "Volume pricing starts at 80 units." });
  });

  it("declines Bodega's volume request because its prices are fixed", () => {
    expect(t(1, M.bodega, "volume_discount")).toMatchObject({ outcome: "declined", reply: NEG.bodegaVolumeReply });
    expect(m.latest(M.bodega).revision).toBe(1);
  });

  it("prices Juniper & Rye at $803.14 in round 2", () => {
    const e = t(2, M.juniper, "volume_discount");
    expect(e.offer).toMatchObject({ revision: NEG.juniper.volumeRevision, totalCents: NEG.juniper.volumeTotalCents });
    expect(e.offer?.totalCents).toBe(80_314);
    expect(e.offer?.fulfillment.timeLocal).toBe(NEG.juniper.arrivalLocal);
    expect(e.offer?.provenance.round).toBe(2);
  });

  it("supersedes every replaced revision and leaves exactly the latest open", () => {
    const status = (id: string, rev: number) => must(m.offers.find((o) => o.id === id && o.revision === rev)).status;
    expect([1, 2, 3].map((r) => status(OFFER_IDS.goldenHour, r))).toEqual(["superseded", "superseded", "open"]);
    expect([1, 2].map((r) => status(OFFER_IDS.fogline, r))).toEqual(["superseded", "open"]);
    expect([1, 2].map((r) => status(OFFER_IDS.juniper, r))).toEqual(["superseded", "open"]);
    for (const id of [OFFER_IDS.bodega, OFFER_IDS.pelican, OFFER_IDS.swiftline]) expect(status(id, 1)).toBe("open");
    expect(m.offers.every((o) => Offer.safeParse(o).success)).toBe(true);
  });

  it("grows the feasible set 0 -> 3 -> 4 and clears at $784.40 with 20 minutes of slack", () => {
    expect(m.solves.map((s) => s.feasibleCandidates)).toEqual([...NEG.feasiblePerRound]);
    const best = must(m.final.best);
    expect(best.offers.map((o) => o.merchantName).sort()).toEqual([...NEG.bestMerchants].sort());
    expect(best.totalCents).toBe(NEG.bestTotalCents);
    expect(best.slackMinutes).toBe(NEG.bestSlackMinutes);
    expect(must(m.solves[1]?.best).totalCents).toBe(NEG.bestTotalCents); // round 1 already finds the winner
  });

  it("is deterministic: the same inputs reproduce the same transcript and offers", () => {
    const again = runMarket();
    const strip = (x: typeof m) => JSON.stringify({ transcript: x.transcript, offers: x.offers, rejected: x.solves.map((s) => s.rejectedByReason) });
    expect(strip(again)).toBe(strip(m));
  });

  it("falls back to asking the courier for a later pickup when the pickup supplier will not move", () => {
    const inflexibleGolden = CATALOG.map((x) => (x.id === M.goldenHour ? tweakMerchant(M.goldenHour, { policy: { slotFlexible: false } }) : x));
    const g = runMarket({ merchants: inflexibleGolden });
    const decline = must(g.transcript.find((e) => e.request.offerId === OFFER_IDS.goldenHour && e.request.lever === "earlier_slot"));
    expect(decline).toMatchObject({ round: 1, outcome: "declined", reply: "Only one time window is available." });
    const later = must(g.transcript.find((e) => e.request.lever === "later_pickup"));
    expect(later).toMatchObject({ round: 2, outcome: "revised", merchantName: "Pelican Couriers" });
    expect(later.offer?.fulfillment).toMatchObject({ timeLocal: "18:05", pickupByLocal: "17:30" });
    const best = must(g.final.best);
    expect(best.totalCents).toBe(NEG.bestTotalCents);
    expect(best.slackMinutes).toBe(5); // 18:10 latest arrival - 18:05 courier arrival
    expect(best.offers.find((o) => o.merchantId === M.goldenHour)?.fulfillment.timeLocal).toBe("17:30");
  });
});

describe("headcount growth to 85 (pure-module part of the LLD matrix row)", () => {
  it("quotes Golden Hour as a 70-of-85 partial, and re-quotes Harbor at 6% volume pricing ($891.32)", () => {
    const m = runMarket({ headcount: 85 });
    expect(m.skipped[M.goldenHour]).toBeUndefined();
    expect(m.latest(M.goldenHour).partial).toEqual({ coversMeals: 70, ofMeals: 85 });
    expect(m.skipped[M.harbor]).toBeUndefined();
    expect(m.latest(M.harbor).totalCents).toBe(89_132);
    // Juniper (capacity 90) can serve 85 but is never worth a volume ask at $1,000: it stays at list price.
    expect(m.latest(M.juniper)).toMatchObject({ revision: 1, totalCents: 122_388 });
    // With $1,200 it becomes a near miss, the buyer asks in round 2, and the 8% price is $1,129.17.
    const roomier = runMarket({ headcount: 85, budgetCents: 120_000 });
    expect(roomier.latest(M.juniper)).toMatchObject({ revision: 2, totalCents: 112_917 });
  });

  it("is infeasible at $1,000 with a gap of exactly $143.57", () => {
    const m = runMarket({ headcount: 85 });
    expect(m.final.best).toBeNull();
    const inf = explainInfeasibility(m.ctx, m.final, groupsOpen(m.offers));
    expect(inf.kind).toBe("over_budget");
    const cheapest = must(inf.cheapestInvalid);
    expect(cheapest.merchants.sort()).toEqual(["Bodega Marquez", "Harbor Kitchen Collective", "Swiftline Runners"]);
    expect(cheapest.budgetGapCents).toBe(EXPECTED.headcount85GapCents);
    expect(cheapest.totalCents).toBe(114_357);
  });

  it("recovers at $1,200 with Bodega re-quoted at 85, Harbor and Swiftline for $1,143.57", () => {
    const m = runMarket({ headcount: 85, budgetCents: 120_000 });
    const best = must(m.final.best);
    expect(best.totalCents).toBe(EXPECTED.headcount85RecoveredAt1200Cents);
    expect(best.offers.map((o) => [o.merchantName, o.totalCents]).sort()).toEqual([
      ["Bodega Marquez", 20_825],
      ["Harbor Kitchen Collective", 89_132],
      ["Swiftline Runners", 4_400],
    ]);
    expect(best.slackMinutes).toBe(10);
  });
});
