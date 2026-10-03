/**
 * Design-time simulation: runs the pure modules (no store, no server) through
 * the flagship scenario and prints what the solver computes. Development
 * diagnostic only; not part of the app.
 */
import { CATALOG, DEMO_VENUE, toPublic } from "../src/lib/catalog";
import type { Availability, Offer, PlanSelection, SimOrder } from "../src/lib/contracts";
import { interpretLocal } from "../src/lib/interpret";
import { formatCents } from "../src/lib/money";
import { planRound } from "../src/lib/buyer";
import { quote, respond } from "../src/lib/seller";
import { deriveDemand, solve, type SolveContext } from "../src/lib/solver";
import { cancellationExposure } from "../src/lib/ledger";

const nowIso = "2026-10-16T21:00:00.000Z";
const req = interpretLocal({
  text: "Dinner for 60 hackathon attendees at our already-booked venue. At least 20 need vegetarian meals; the rest are flexible. Include nonalcoholic drinks, plates, and utensils. Everything ready by 6:30 PM. Maximum $1,000 including all fees and delivery.",
  eventDate: "2026-10-16",
  timezone: "America/Los_Angeles",
  nowLocal: "14:00",
});
console.log("REQUIREMENTS", { headcount: req.headcount, veg: req.vegetarianMin, readyBy: req.readyByLocal, budget: formatCents(req.budgetCents), missing: req.missing, venue: DEMO_VENUE.name });

function run(headcount: number, budgetCents: number, availability: Record<string, Availability>, previous?: { selections: PlanSelection[]; activeOrders: SimOrder[] }, sunkCents = 0) {
  const r = { ...req, headcount, budgetCents };
  const demand = deriveDemand(r);
  const offers: Offer[] = [];
  const qctx = { demand, requestVersion: 1, nowIso, reasoning: "local" as const };
  for (const m of CATALOG) {
    if (availability[m.id]?.available === false) continue;
    const q = quote(m, qctx);
    if (q.kind === "offer") offers.push(q.offer);
    else console.log(`  skip ${m.name}: ${q.reason}`);
  }
  const ctx: SolveContext = {
    demand, offers, merchants: CATALOG.map(toPublic), availability, nowIso, sunkCents,
    ...(previous ? { previous } : {}),
    cancellationTermsFor: (id) => CATALOG.find((m) => m.id === id)?.cancellation,
  };
  const asked = new Set<string>();
  for (let round = 0; round <= 2; round++) {
    ctx.offers = offers;
    const res = solve(ctx);
    const best = res.best;
    console.log(`  round ${round}: checked=${res.candidatesChecked} feasible=${res.feasibleCandidates} best=${best ? best.offers.map((o) => `${o.merchantName}@r${o.revision}`).join(" + ") + " " + formatCents(best.totalCents) + " slack " + best.slackMinutes : "none"} rejects=${JSON.stringify(res.rejectedByReason)}`);
    if (round === 2) return { res, offers };
    const pr = planRound(res, demand, round + 1, asked, offers);
    for (const rq of pr.requests) {
      asked.add(`${rq.offerId}:${rq.lever}`);
      const cur = offers.filter((o) => o.id === rq.offerId).sort((a, b) => b.revision - a.revision)[0]!;
      const m = CATALOG.find((x) => x.id === rq.merchantId)!;
      const out = respond(m, cur, rq.lever, round + 1, qctx);
      if (out.outcome === "revised") {
        cur.status = "superseded";
        offers.push(out.offer);
        console.log(`    ${m.name} ${rq.lever} → revised r${out.offer.revision} ${formatCents(out.offer.totalCents)} ${out.offer.fulfillment.timeLocal} — ${out.reply}`);
      } else console.log(`    ${m.name} ${rq.lever} → declined — ${out.reply}`);
    }
  }
  throw new Error("unreachable");
}

const avail: Record<string, Availability> = {};
console.log("\n== 60 attendees, $1,000 ==");
const first = run(60, 100000, avail);
const best = first.res.best!;
const selections: PlanSelection[] = best.offers.map((o) => ({ offerId: o.id, offerRevision: o.revision, merchantId: o.merchantId, merchantName: o.merchantName, group: o.group, totalCents: o.totalCents, coverage: {} as never, change: "added" }));
const orders: SimOrder[] = best.offers.map((o, i) => ({ id: `ord${i}`, merchantId: o.merchantId, merchantName: o.merchantName, offerId: o.id, offerRevision: o.revision, planRevision: 1, amountCents: o.totalCents, status: "simulated_confirmed", simulated: true, placedAt: nowIso }));

console.log("\n== cancel the meals supplier ==");
const mealsOrder = orders.find((o) => CATALOG.find((m) => m.id === o.merchantId)!.group === "meals")!;
const terms = CATALOG.find((m) => m.id === mealsOrder.merchantId)!.cancellation;
const c = cancellationExposure(mealsOrder.amountCents, terms);
console.log("  cancellation", mealsOrder.merchantName, c);
avail[mealsOrder.merchantId] = { available: false, reason: "Supplier cancelled (simulated)" };
const remaining = orders.filter((o) => o.id !== mealsOrder.id);
const sunk = c.retainedCents + (c.refundStatus === "pending" ? c.refundCents : 0);
const second = run(60, 100000, avail, { selections, activeOrders: remaining }, sunk);
const b2 = second.res.best;
if (b2) console.log("  repaired:", b2.offers.map((o) => `${o.merchantName} ${formatCents(o.totalCents)}`).join(" | "), "exposure", formatCents(b2.exposureCents), "changeScore", b2.changeScore);

console.log("\n== headcount 85 at $1,000 ==");
const sel2: PlanSelection[] = (b2?.offers ?? []).map((o) => ({ offerId: o.id, offerRevision: o.revision, merchantId: o.merchantId, merchantName: o.merchantName, group: o.group, totalCents: o.totalCents, coverage: {} as never, change: "added" }));
const ord2: SimOrder[] = (b2?.offers ?? []).map((o, i) => ({ id: `o2${i}`, merchantId: o.merchantId, merchantName: o.merchantName, offerId: o.id, offerRevision: o.revision, planRevision: 2, amountCents: o.totalCents, status: "simulated_confirmed", simulated: true, placedAt: nowIso }));
const third = run(85, 100000, avail, { selections: sel2, activeOrders: ord2 }, sunk);
if (!third.res.best) {
  const over = third.res.candidates.filter((x) => x.rejects.every((r) => r === "over_budget")).sort((a, b) => a.exposureCents - b.exposureCents)[0];
  console.log("  infeasible; cheapest over-budget:", over ? over.offers.map((o) => o.merchantName).join(" + ") + " exposure " + formatCents(over.exposureCents) + " gap " + formatCents(over.exposureCents - 100000) : "none");
}
console.log("\n== headcount 85 at $1,200 ==");
const fourth = run(85, 120000, avail, { selections: sel2, activeOrders: ord2 }, sunk);
if (fourth.res.best) console.log("  recovered:", fourth.res.best.offers.map((o) => `${o.merchantName} ${formatCents(o.totalCents)}`).join(" | "), "exposure", formatCents(fourth.res.best.exposureCents));
