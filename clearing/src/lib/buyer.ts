/**
 * Buyer-side negotiation strategy (local rules).
 *
 * Looks at the candidates the solver evaluated, shortlists the cheapest
 * feasible and near-miss combinations, and derives targeted concession
 * requests. Each request names a concrete permitted lever. A live model may
 * replace the lever choice; the shortlist, caps and validation stay in code.
 */
import type { NegotiationLever, Offer } from "./contracts";
import { nearMisses, type Candidate, type Demand, type SolveResult } from "./solver";
import { toMinutes } from "./time";

export interface CounterRequest {
  offerId: string;
  merchantId: string;
  lever: NegotiationLever;
  ask: string;
}

export const MAX_REQUESTS_PER_ROUND = 6;
export const MAX_ROUNDS = 2;

function leversFor(c: Candidate, demand: Demand, round: number): CounterRequest[] {
  const out: CounterRequest[] = [];
  const courier = c.offers.find((o) => o.fulfillment.mode === "courier");
  const pickupBy = courier?.fulfillment.pickupByLocal ? toMinutes(courier.fulfillment.pickupByLocal) : Number.POSITIVE_INFINITY;

  for (const o of c.offers) {
    if (c.rejects.includes("arrival_too_late") && o.fulfillment.mode !== "pickup_only" && toMinutes(o.fulfillment.timeLocal) > demand.latestArrivalMin) {
      out.push({ offerId: o.id, merchantId: o.merchantId, lever: "earlier_slot", ask: `Arrival ${o.fulfillment.timeLocal} is after the latest arrival; please move earlier.` });
    }
    if (c.rejects.includes("pickup_too_late") && o.fulfillment.mode === "pickup_only" && toMinutes(o.fulfillment.timeLocal) > pickupBy) {
      // Round 1 asks the pickup supplier to be ready earlier; round 2 asks the courier for a later window.
      if (round === 1) out.push({ offerId: o.id, merchantId: o.merchantId, lever: "earlier_slot", ask: `Ready ${o.fulfillment.timeLocal} misses the courier pickup window; can it be earlier?` });
      else if (courier) out.push({ offerId: courier.id, merchantId: courier.merchantId, lever: "later_pickup", ask: `Pickup at ${o.fulfillment.timeLocal} needs a later collection window.` });
    }
  }
  // Price pressure on the largest tickets, feasible or over budget alike.
  const byCost = [...c.offers].filter((o) => o.fulfillment.mode !== "courier").sort((a, b) => b.totalCents - a.totalCents);
  for (const o of byCost.slice(0, 2)) {
    out.push({ offerId: o.id, merchantId: o.merchantId, lever: "volume_discount", ask: `Volume pricing for ${o.lines.reduce((s, l) => s + l.qty, 0)} units?` });
  }
  return out;
}

export interface PlanRound {
  requests: CounterRequest[];
  shortlist: string[];
}

/** Derive this round's targeted requests. Skips levers already asked on an offer. */
export function planRound(result: SolveResult, demand: Demand, round: number, asked: Set<string>, offers: Offer[]): PlanRound {
  const feasible = result.candidates.filter((c) => c.feasible).sort((a, b) => a.totalCents - b.totalCents).slice(0, 2);
  const misses = nearMisses(result).slice(0, 3);
  const shortlist = [...feasible, ...misses];
  const latest = new Map<string, Offer>();
  for (const o of offers) {
    const cur = latest.get(o.id);
    if (!cur || o.revision > cur.revision) latest.set(o.id, o);
  }
  const requests: CounterRequest[] = [];
  const seen = new Set<string>();
  for (const c of shortlist) {
    for (const r of leversFor(c, demand, round)) {
      const key = `${r.offerId}:${r.lever}`;
      if (seen.has(key) || asked.has(key)) continue;
      const cur = latest.get(r.offerId);
      if (!cur || cur.status !== "open") continue;
      seen.add(key);
      requests.push(r);
      if (requests.length >= MAX_REQUESTS_PER_ROUND) break;
    }
    if (requests.length >= MAX_REQUESTS_PER_ROUND) break;
  }
  return { requests, shortlist: shortlist.map((c) => c.offers.map((o) => o.merchantName).join(" + ")) };
}
