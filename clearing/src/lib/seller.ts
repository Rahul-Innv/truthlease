/**
 * Seller-side logic. Each merchant quotes from its own catalog and responds to
 * concession requests using only its private policy. Code enforces price
 * floors, slot membership, quantity limits and capacity on every revision —
 * a live model may only *suggest* which permitted response to give.
 */
import type { Merchant, NegotiationLever, Offer, OfferLine } from "./contracts";
import { discountedUnit, pctOf } from "./money";
import { addMinutes, toMinutes } from "./time";
import type { Demand } from "./solver";

export const OFFER_TTL_MS = 3 * 60 * 60 * 1000;

export interface QuoteContext {
  demand: Demand;
  requestVersion: number;
  nowIso: string;
  reasoning: "local" | "live";
}

export type QuoteResult = { kind: "offer"; offer: Offer } | { kind: "skip"; reason: string };

function offerId(merchantId: string, requestVersion: number): string {
  return `off_${merchantId.replace(/^m-/, "")}_v${requestVersion}`;
}

function priceLines(m: Merchant, qtyByKind: Partial<Record<OfferLine["kind"], number>>, discountPct: number): OfferLine[] | string {
  const lines: OfferLine[] = [];
  for (const item of m.catalog) {
    let qty = qtyByKind[item.kind] ?? 0;
    if (qty === 0) continue;
    if (qty < item.minQty) qty = item.minQty; // seller enforces its own minimum; buyer pays for the oversupply
    if (qty > item.maxQty) return `${item.label}: max ${item.maxQty} per order`;
    const unitCents = discountPct > 0 ? discountedUnit(item.unitCents, discountPct, m.policy.floorPctOfList) : item.unitCents;
    lines.push({ sku: item.sku, label: item.label, kind: item.kind, qty, unitCents, lineCents: unitCents * qty });
  }
  return lines;
}

function assemble(m: Merchant, lines: OfferLine[], slotId: string, ctx: QuoteContext, revision: number, round: number, note: string, supersedes?: number): Offer {
  const slot = m.fulfillment.slots.find((s) => s.id === slotId) ?? m.fulfillment.slots[0]!;
  const goods = lines.reduce((s, l) => s + l.lineCents, 0);
  const fees = m.serviceFeePct > 0 ? [{ label: `Service fee (${m.serviceFeePct}%)`, cents: pctOf(goods, m.serviceFeePct) }] : [];
  const deliveryCents = m.fulfillment.mode === "included_delivery" ? (m.fulfillment.deliveryFeeCents ?? 0) : null;
  const totalCents = goods + fees.reduce((s, f) => s + f.cents, 0) + (deliveryCents ?? 0);
  const conditions: string[] = [];
  if (m.fulfillment.mode === "pickup_only") conditions.push("Pickup only: a courier must collect the order.");
  if (m.fulfillment.mode === "included_delivery" && deliveryCents === 0) conditions.push("Delivery included in quoted prices.");
  return {
    id: offerId(m.id, ctx.requestVersion),
    merchantId: m.id,
    merchantName: m.name,
    group: m.group,
    revision,
    ...(supersedes ? { supersedesRevision: supersedes } : {}),
    status: "open",
    requestVersion: ctx.requestVersion,
    lines,
    fees,
    deliveryCents,
    totalCents,
    fulfillment: {
      mode: m.fulfillment.mode,
      slotId: slot.id,
      timeLocal: slot.timeLocal,
      ...(slot.pickupByLocal ? { pickupByLocal: slot.pickupByLocal } : {}),
      ...(m.capacity.maxPickups !== undefined ? { maxPickups: m.capacity.maxPickups } : {}),
    },
    expiresAt: new Date(Date.parse(ctx.nowIso) + OFFER_TTL_MS).toISOString(),
    conditions,
    unpriced: [],
    provenance: { supply: "demo_catalog", reasoning: ctx.reasoning, round, note },
    createdAt: ctx.nowIso,
  };
}

/** Initial quote (round 0). Sellers decline when the request is outside what they can serve. */
export function quote(m: Merchant, ctx: QuoteContext): QuoteResult {
  const d = ctx.demand;
  if (!m.serviceZones.includes(d.zone)) return { kind: "skip", reason: `Does not serve zone "${d.zone}"` };
  const qty: Partial<Record<OfferLine["kind"], number>> = {};
  if (m.group === "meals") {
    const meals = d.headcount;
    if (m.capacity.maxMeals !== undefined && meals > m.capacity.maxMeals) return { kind: "skip", reason: `Capacity ${m.capacity.maxMeals} meals < ${meals} needed` };
    if (m.minMeals !== undefined && meals < m.minMeals) return { kind: "skip", reason: `Minimum order ${m.minMeals} meals > ${meals} needed` };
    qty.meal_vegetarian = d.vegetarianMin;
    qty.meal_standard = d.headcount - d.vegetarianMin;
  } else if (m.group === "drinks_consumables") {
    if (d.required.drink_serving + d.required.plate + d.required.utensil_set === 0) return { kind: "skip", reason: "No drinks or consumables requested" };
    if (m.capacity.maxDrinkServings !== undefined && d.required.drink_serving > m.capacity.maxDrinkServings) return { kind: "skip", reason: `Capacity ${m.capacity.maxDrinkServings} servings < ${d.required.drink_serving} needed` };
    qty.drink_serving = d.required.drink_serving;
    qty.plate = d.required.plate;
    qty.utensil_set = d.required.utensil_set;
  } else {
    qty.delivery_run = 1;
  }
  // Pickup-only sellers must be able to be ready by their slot given lead time.
  const slot = m.fulfillment.slots.find((s) => s.id === m.fulfillment.defaultSlotId) ?? m.fulfillment.slots[0]!;
  if (toMinutes(slot.timeLocal) < d.nowMin + m.leadTimeMinutes) return { kind: "skip", reason: `Lead time ${m.leadTimeMinutes} min cannot meet ${slot.label}` };
  const lines = priceLines(m, qty, 0);
  if (typeof lines === "string") return { kind: "skip", reason: lines };
  if (lines.length === 0) return { kind: "skip", reason: "Nothing to quote" };
  return { kind: "offer", offer: assemble(m, lines, slot.id, ctx, 1, 0, "Initial quote at list price") };
}

export type ConcessionResult = { outcome: "revised"; offer: Offer; reply: string } | { outcome: "declined"; reply: string };

function primaryQty(o: Offer): number {
  if (o.group === "meals") return o.lines.filter((l) => l.kind === "meal_vegetarian" || l.kind === "meal_standard").reduce((s, l) => s + l.qty, 0);
  if (o.group === "drinks_consumables") return o.lines.filter((l) => l.kind === "drink_serving").reduce((s, l) => s + l.qty, 0);
  return 1;
}

function appliedDiscountPct(m: Merchant, o: Offer): number {
  const first = o.lines[0];
  const item = first ? m.catalog.find((c) => c.sku === first.sku) : undefined;
  if (!first || !item || item.unitCents === 0) return 0;
  return Math.round((1 - first.unitCents / item.unitCents) * 100);
}

/**
 * Respond to a concession request. Deterministic: the same request on the same
 * offer yields the same reply. All permitted changes are validated here.
 */
export function respond(m: Merchant, current: Offer, lever: NegotiationLever, round: number, ctx: QuoteContext): ConcessionResult {
  if (round > m.policy.maxRounds) return { outcome: "declined", reply: "Not negotiating further on this request." };
  const nextRev = current.revision + 1;
  const qtyByKind: Partial<Record<OfferLine["kind"], number>> = {};
  for (const l of current.lines) qtyByKind[l.kind] = l.qty;

  if (lever === "volume_discount") {
    const q = primaryQty(current);
    const tier = [...m.policy.volumeDiscount].sort((a, b) => b.pct - a.pct).find((t) => q >= t.minQty);
    if (!tier) {
      const lowest = [...m.policy.volumeDiscount].sort((a, b) => a.minQty - b.minQty)[0];
      return { outcome: "declined", reply: lowest ? `Volume pricing starts at ${lowest.minQty} units.` : "Fixed pricing; no volume discount available." };
    }
    if (appliedDiscountPct(m, current) >= tier.pct) return { outcome: "declined", reply: "Already at the best available volume price." };
    const lines = priceLines(m, qtyByKind, tier.pct);
    if (typeof lines === "string") return { outcome: "declined", reply: lines };
    const offer = assemble(m, lines, current.fulfillment.slotId, ctx, nextRev, round, `Applied ${tier.pct}% volume discount at ≥${tier.minQty} units`, current.revision);
    return { outcome: "revised", offer, reply: `Applied a ${tier.pct}% volume discount for ${q} units.` };
  }

  if (lever === "earlier_slot") {
    if (!m.policy.slotFlexible) return { outcome: "declined", reply: "Only one time window is available." };
    const cur = toMinutes(current.fulfillment.timeLocal);
    const earliest = m.fulfillment.slots
      .filter((s) => toMinutes(s.timeLocal) < cur && toMinutes(s.timeLocal) >= ctx.demand.nowMin + m.leadTimeMinutes)
      .sort((a, b) => toMinutes(a.timeLocal) - toMinutes(b.timeLocal))[0];
    if (!earliest) return { outcome: "declined", reply: `No earlier window; lead time is ${m.leadTimeMinutes} min.` };
    const lines = priceLines(m, qtyByKind, appliedDiscountPct(m, current));
    if (typeof lines === "string") return { outcome: "declined", reply: lines };
    const offer = assemble(m, lines, earliest.id, ctx, nextRev, round, `Moved to ${earliest.label}`, current.revision);
    return { outcome: "revised", offer, reply: `Moved to ${earliest.label}.` };
  }

  // later_pickup: courier accepts a later pickup window (later arrival as a consequence).
  if (m.fulfillment.mode !== "courier") return { outcome: "declined", reply: "Not a courier offer." };
  if (!m.policy.slotFlexible) return { outcome: "declined", reply: "Only one run time is available." };
  const curPickup = current.fulfillment.pickupByLocal ? toMinutes(current.fulfillment.pickupByLocal) : 0;
  const later = m.fulfillment.slots
    .filter((s) => s.pickupByLocal && toMinutes(s.pickupByLocal) > curPickup)
    .sort((a, b) => toMinutes(a.pickupByLocal!) - toMinutes(b.pickupByLocal!))[0];
  if (!later) return { outcome: "declined", reply: "No later pickup window available." };
  const lines = priceLines(m, qtyByKind, 0);
  if (typeof lines === "string") return { outcome: "declined", reply: lines };
  const offer = assemble(m, lines, later.id, ctx, nextRev, round, `Moved to ${later.label}`, current.revision);
  return { outcome: "revised", offer, reply: `Moved to ${later.label}.` };
}

/** A delivery delay reported by a supplier: the offer's arrival moves later. Server-only mutation. */
export function delayOffer(current: Offer, delayMinutes: number, nowIso: string): Offer {
  const timeLocal = addMinutes(current.fulfillment.timeLocal, delayMinutes);
  return {
    ...current,
    revision: current.revision + 1,
    supersedesRevision: current.revision,
    fulfillment: { ...current.fulfillment, timeLocal },
    conditions: [...current.conditions, `Supplier reported a ${delayMinutes}-minute delay.`].slice(0, 10),
    provenance: { ...current.provenance, note: `Delayed ${delayMinutes} min by supplier` },
    createdAt: nowIso,
  };
}
