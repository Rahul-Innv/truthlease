/**
 * Deterministic clearing engine.
 *
 * Enumerates bounded candidate combinations of open offers, validates each
 * against coverage, dietary needs, capacity, validity, fulfillment timing,
 * service area, pricing completeness and budget, and selects the best
 * candidate. "Best" is defined only among the candidates actually evaluated.
 */
import {
  DEMAND_ITEM_KINDS,
  ItemKind,
  RejectCode,
  type Availability,
  type CancellationTerms,
  type Infeasibility,
  type MerchantPublic,
  type Offer,
  type Plan,
  type PlanSelection,
  type Requirements,
  type SimOrder,
} from "./contracts";
import { sunkOnCancel } from "./ledger";
import { fromMinutes, toMinutes } from "./time";

export interface Demand {
  headcount: number;
  vegetarianMin: number;
  required: Record<ItemKind, number>;
  zone: string;
  nowMin: number;
  readyByMin: number;
  latestArrivalMin: number;
  budgetCents: number;
}

export function deriveDemand(req: Requirements): Demand {
  const h = req.headcount;
  const readyByMin = toMinutes(req.readyByLocal);
  return {
    headcount: h,
    vegetarianMin: req.vegetarianMin,
    required: {
      meal_vegetarian: req.vegetarianMin,
      meal_standard: Math.max(0, h - req.vegetarianMin), // informational; meals total is the real constraint
      drink_serving: req.items.drinks ? h : 0,
      plate: req.items.plates ? h : 0,
      utensil_set: req.items.utensils ? h : 0,
      delivery_run: 0,
    },
    zone: req.venue.zone,
    nowMin: toMinutes(req.nowLocal),
    readyByMin,
    latestArrivalMin: readyByMin - req.setupBufferMinutes,
    budgetCents: req.budgetCents,
  };
}

export interface PreviousState {
  selections: PlanSelection[];
  /** Active simulated orders that would have to be cancelled if dropped. */
  activeOrders: SimOrder[];
}

export interface SolveContext {
  demand: Demand;
  offers: Offer[];
  merchants: MerchantPublic[];
  availability: Record<string, Availability>;
  nowIso: string;
  /** Retained charges + pending refunds already on the ledger. */
  sunkCents: number;
  previous?: PreviousState;
  cancellationTermsFor: (merchantId: string) => CancellationTerms | undefined;
  maxOffersPerCandidate?: number;
}

export interface Candidate {
  offers: Offer[];
  rejects: RejectCode[];
  feasible: boolean;
  goodsCents: number;
  feesCents: number;
  deliveryCents: number;
  totalCents: number;
  /** New spend + sunk + cancellation cost of dropped orders. */
  exposureCents: number;
  coverage: Record<ItemKind, { required: number; supplied: number }>;
  lastArrivalMin: number;
  slackMinutes: number;
  unresolvedConditions: string[];
  fullyPriced: boolean;
  changeScore: number;
  deliversFor: Record<string, string[]>;
}

export interface SolveResult {
  best: Candidate | null;
  candidates: Candidate[];
  candidatesChecked: number;
  feasibleCandidates: number;
  rejectedByReason: Partial<Record<RejectCode, number>>;
  solverMs: number;
}

export function supplied(offers: Offer[]): Record<ItemKind, number> {
  const s: Record<ItemKind, number> = { meal_vegetarian: 0, meal_standard: 0, drink_serving: 0, plate: 0, utensil_set: 0, delivery_run: 0 };
  for (const o of offers) for (const l of o.lines) s[l.kind] += l.qty;
  return s;
}

function latestOpenRevisions(offers: Offer[]): Offer[] {
  const byId = new Map<string, Offer>();
  for (const o of offers) {
    const cur = byId.get(o.id);
    if (!cur || o.revision > cur.revision) byId.set(o.id, o);
  }
  return [...byId.values()].filter((o) => o.status === "open");
}

/** Validate one specific set of offer revisions. Used by enumeration and by approval revalidation. */
export function validateCandidate(ctx: SolveContext, offers: Offer[]): Candidate {
  const { demand } = ctx;
  const rejects: RejectCode[] = [];
  const merchantById = new Map(ctx.merchants.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const nowMs = Date.parse(ctx.nowIso);

  for (const o of offers) {
    if (o.status !== "open") rejects.push("offer_not_open");
    if (Date.parse(o.expiresAt) <= nowMs) rejects.push("offer_expired");
    const avail = ctx.availability[o.merchantId];
    if (avail && !avail.available) rejects.push("merchant_unavailable");
    if (seen.has(o.merchantId)) rejects.push("duplicate_merchant");
    seen.add(o.merchantId);
    const m = merchantById.get(o.merchantId);
    if (!m) rejects.push("merchant_unavailable");
    else if (!m.serviceZones.includes(demand.zone)) rejects.push("service_area");
  }

  // Coverage. Vegetarian meals may serve flexible attendees; standard meals never satisfy vegetarian need.
  const sup = supplied(offers);
  const coverage = {} as Record<ItemKind, { required: number; supplied: number }>;
  for (const k of DEMAND_ITEM_KINDS) coverage[k] = { required: demand.required[k], supplied: sup[k] };
  coverage.delivery_run = { required: 0, supplied: sup.delivery_run };
  const mealsSupplied = sup.meal_vegetarian + sup.meal_standard;
  if (sup.meal_vegetarian < demand.vegetarianMin) rejects.push("dietary_shortfall");
  if (mealsSupplied < demand.headcount) rejects.push("incomplete_coverage");
  for (const k of ["drink_serving", "plate", "utensil_set"] as const) {
    if (sup[k] < demand.required[k]) rejects.push("incomplete_coverage");
  }

  // Capacity per merchant across all of its selected offers (no double allocation).
  const perMerchant = new Map<string, Record<ItemKind, number>>();
  for (const o of offers) {
    const acc = perMerchant.get(o.merchantId) ?? supplied([]);
    for (const l of o.lines) acc[l.kind] += l.qty;
    perMerchant.set(o.merchantId, acc);
  }
  for (const [mid, acc] of perMerchant) {
    const m = merchantById.get(mid);
    if (!m) continue;
    const meals = acc.meal_vegetarian + acc.meal_standard;
    if (m.capacity.maxMeals !== undefined && meals > m.capacity.maxMeals) rejects.push("capacity_exceeded");
    if (m.capacity.maxDrinkServings !== undefined && acc.drink_serving > m.capacity.maxDrinkServings) rejects.push("capacity_exceeded");
    if (m.minMeals !== undefined && meals > 0 && meals < m.minMeals) rejects.push("below_min_order");
  }

  // Fulfillment dependencies: pickup-only offers need exactly one courier with capacity and compatible timing.
  const pickups = offers.filter((o) => o.fulfillment.mode === "pickup_only");
  const couriers = offers.filter((o) => o.fulfillment.mode === "courier");
  const deliversFor: Record<string, string[]> = {};
  if (pickups.length > 0 && couriers.length === 0) rejects.push("needs_delivery");
  if (couriers.length > 0 && pickups.length === 0) rejects.push("delivery_unused");
  if (couriers.length > 1) rejects.push("delivery_unused");
  const courier = couriers[0];
  if (courier && pickups.length > 0) {
    deliversFor[courier.id] = pickups.map((p) => p.id);
    const max = courier.fulfillment.maxPickups ?? 1;
    if (pickups.length > max) rejects.push("courier_capacity");
    const pickupBy = courier.fulfillment.pickupByLocal ? toMinutes(courier.fulfillment.pickupByLocal) : Number.POSITIVE_INFINITY;
    for (const p of pickups) if (toMinutes(p.fulfillment.timeLocal) > pickupBy) rejects.push("pickup_too_late");
  }

  // Arrival timing with setup buffer.
  const arrivals = offers.filter((o) => o.fulfillment.mode !== "pickup_only").map((o) => toMinutes(o.fulfillment.timeLocal));
  const lastArrivalMin = arrivals.length ? Math.max(...arrivals) : demand.nowMin;
  if (lastArrivalMin > demand.latestArrivalMin) rejects.push("arrival_too_late");
  const slackMinutes = demand.latestArrivalMin - lastArrivalMin;

  // Pricing completeness.
  const unresolvedConditions = offers.flatMap((o) => [...o.conditions, ...o.unpriced.map((u) => `Unpriced: ${u}`)]);
  const fullyPriced = offers.every((o) => o.unpriced.length === 0);
  if (!fullyPriced) rejects.push("not_fully_priced");

  // Totals.
  let goodsCents = 0;
  let feesCents = 0;
  let deliveryCents = 0;
  for (const o of offers) {
    if (o.fulfillment.mode === "courier") {
      deliveryCents += o.totalCents;
      continue;
    }
    goodsCents += o.lines.reduce((s, l) => s + l.lineCents, 0);
    feesCents += o.fees.reduce((s, f) => s + f.cents, 0);
    deliveryCents += o.deliveryCents ?? 0;
  }
  const totalCents = goodsCents + feesCents + deliveryCents;

  // Budget exposure including what dropping previous orders would leave behind.
  let dropCost = 0;
  let changeScore = 0;
  if (ctx.previous) {
    const selectedKeys = new Set(offers.map((o) => `${o.id}@${o.revision}`));
    const selectedMerchants = new Set(offers.map((o) => o.merchantId));
    for (const order of ctx.previous.activeOrders) {
      if (selectedKeys.has(`${order.offerId}@${order.offerRevision}`)) continue; // kept, no cancellation
      const terms = ctx.cancellationTermsFor(order.merchantId);
      dropCost += terms ? sunkOnCancel(order.amountCents, terms) : order.amountCents;
    }
    const prevKeys = new Set(ctx.previous.selections.map((s) => `${s.offerId}@${s.offerRevision}`));
    const prevMerchants = new Set(ctx.previous.selections.map((s) => s.merchantId));
    for (const o of offers) {
      if (prevKeys.has(`${o.id}@${o.revision}`)) continue;
      changeScore += prevMerchants.has(o.merchantId) ? 1 : 2;
    }
    for (const s of ctx.previous.selections) if (!selectedMerchants.has(s.merchantId)) changeScore += 1;
  }
  const exposureCents = totalCents + ctx.sunkCents + dropCost;
  if (exposureCents > demand.budgetCents) rejects.push("over_budget");

  const uniq = [...new Set(rejects)];
  return {
    offers,
    rejects: uniq,
    feasible: uniq.length === 0,
    goodsCents,
    feesCents,
    deliveryCents,
    totalCents,
    exposureCents,
    coverage,
    lastArrivalMin,
    slackMinutes,
    unresolvedConditions,
    fullyPriced,
    changeScore,
    deliversFor,
  };
}

function stableKey(c: Candidate): string {
  return c.offers.map((o) => `${o.id}@${o.revision}`).sort().join("+");
}

/** New-plan ordering: lowest all-in cost, then more timing slack, then stable key. */
export function compareFresh(a: Candidate, b: Candidate): number {
  return a.totalCents - b.totalCents || b.slackMinutes - a.slackMinutes || stableKey(a).localeCompare(stableKey(b));
}

/** Repair ordering: fewest changes, then lowest exposure, then slack, then stable key. */
export function compareRepair(a: Candidate, b: Candidate): number {
  return (
    a.changeScore - b.changeScore ||
    a.exposureCents - b.exposureCents ||
    b.slackMinutes - a.slackMinutes ||
    stableKey(a).localeCompare(stableKey(b))
  );
}

function* subsets<T>(items: T[], maxSize: number): Generator<T[]> {
  const n = items.length;
  const pick = (start: number, acc: T[]): Generator<T[]> =>
    (function* () {
      if (acc.length > 0) yield acc;
      if (acc.length === maxSize) return;
      for (let i = start; i < n; i++) yield* pick(i + 1, [...acc, items[i] as T]);
    })();
  yield* pick(0, []);
}

export function solve(ctx: SolveContext): SolveResult {
  const start = performance.now();
  const open = latestOpenRevisions(ctx.offers).sort((a, b) => a.id.localeCompare(b.id));
  const max = ctx.maxOffersPerCandidate ?? 3;
  const candidates: Candidate[] = [];
  const rejectedByReason: Partial<Record<RejectCode, number>> = {};
  for (const set of subsets(open, max)) {
    // Skip duplicate-merchant sets early: they are never valid and would dominate the counts.
    if (new Set(set.map((o) => o.merchantId)).size !== set.length) continue;
    const c = validateCandidate(ctx, set);
    candidates.push(c);
    for (const r of c.rejects) rejectedByReason[r] = (rejectedByReason[r] ?? 0) + 1;
  }
  const feasible = candidates.filter((c) => c.feasible);
  feasible.sort(ctx.previous ? compareRepair : compareFresh);
  return {
    best: feasible[0] ?? null,
    candidates,
    candidatesChecked: candidates.length,
    feasibleCandidates: feasible.length,
    rejectedByReason,
    solverMs: Math.max(0, Math.round(performance.now() - start)),
  };
}

/** Candidates that fail only on constraints a negotiation might fix. */
export function nearMisses(result: SolveResult): Candidate[] {
  const fixable = new Set<RejectCode>(["over_budget", "arrival_too_late", "pickup_too_late"]);
  return result.candidates
    .filter((c) => !c.feasible && c.rejects.every((r) => fixable.has(r)))
    .sort(compareFresh);
}

/**
 * Zod 4 records keyed by an enum are exhaustive, so contract-shaped output must carry every key.
 * Reject reasons that never fired report 0; item kinds a selection does not supply report 0.
 */
function completeRejectCounts(counts: Partial<Record<RejectCode, number>>): Record<RejectCode, number> {
  return Object.fromEntries(RejectCode.options.map((code) => [code, counts[code] ?? 0])) as Record<RejectCode, number>;
}

function completeCoverage(cov: Partial<Record<ItemKind, number>>): Record<ItemKind, number> {
  return Object.fromEntries(ItemKind.options.map((kind) => [kind, cov[kind] ?? 0])) as Record<ItemKind, number>;
}

export interface PlanBuildInput {
  ctx: SolveContext;
  result: SolveResult;
  candidate: Candidate;
  revision: number;
  basedOnRevision?: number;
  requestVersion: number;
  createdAt: string;
  readyByLocal: string;
  latestArrivalLocal: string;
  budgetCents: number;
  sunk: { retainedCents: number; pendingRefundCents: number };
  widened?: string;
}

export function buildPlan(input: PlanBuildInput): Plan {
  const { candidate: c, ctx, result } = input;
  const prev = ctx.previous?.selections ?? [];
  const prevByMerchant = new Map(prev.map((s) => [s.merchantId, s]));
  const prevByGroup = new Map(prev.map((s) => [s.group, s]));
  const prevKeys = new Set(prev.map((s) => `${s.offerId}@${s.offerRevision}`));
  const selections: PlanSelection[] = c.offers.map((o) => {
    const cov: Partial<Record<ItemKind, number>> = {};
    for (const l of o.lines) cov[l.kind] = (cov[l.kind] ?? 0) + l.qty;
    let change: PlanSelection["change"] = "added";
    let replacesMerchantId: string | undefined;
    if (prevKeys.has(`${o.id}@${o.revision}`)) change = "kept";
    else if (prevByMerchant.has(o.merchantId)) change = "requoted";
    else if (prev.length > 0 && prevByGroup.has(o.group)) {
      change = "replaced";
      replacesMerchantId = prevByGroup.get(o.group)?.merchantId;
    } else if (prev.length === 0) change = "added";
    return {
      offerId: o.id,
      offerRevision: o.revision,
      merchantId: o.merchantId,
      merchantName: o.merchantName,
      group: o.group,
      totalCents: o.totalCents,
      coverage: completeCoverage(cov),
      ...(c.deliversFor[o.id] ? { deliversFor: c.deliversFor[o.id] } : {}),
      change,
      ...(replacesMerchantId ? { replacesMerchantId } : {}),
    };
  });

  const kept = selections.filter((s) => s.change === "kept").map((s) => s.merchantName);
  const added = selections.filter((s) => s.change === "added" && prev.length > 0).map((s) => s.merchantName);
  const requoted = selections.filter((s) => s.change === "requoted").map((s) => `${s.merchantName} (re-quoted)`);
  const replaced = selections
    .filter((s) => s.change === "replaced")
    .map((s) => {
      const from = prev.find((p) => p.merchantId === s.replacesMerchantId);
      const why = ctx.availability[from?.merchantId ?? ""]?.reason ?? "previous selection no longer valid";
      return { from: from?.merchantName ?? "previous supplier", to: s.merchantName, why };
    });
  const selectedMerchants = new Set(selections.map((s) => s.merchantId));
  const removed = prev.filter((p) => !selectedMerchants.has(p.merchantId) && !replaced.some((r) => r.from === p.merchantName)).map((p) => p.merchantName);

  const planCents = c.totalCents;
  const exposure = c.exposureCents;
  const plan: Plan = {
    revision: input.revision,
    ...(input.basedOnRevision ? { basedOnRevision: input.basedOnRevision } : {}),
    requestVersion: input.requestVersion,
    status: "proposed",
    selections,
    coverage: c.coverage,
    totals: { goodsCents: c.goodsCents, feesCents: c.feesCents, deliveryCents: c.deliveryCents, totalCents: c.totalCents },
    budget: {
      budgetCents: input.budgetCents,
      planCents,
      retainedCents: input.sunk.retainedCents,
      pendingRefundCents: input.sunk.pendingRefundCents,
      exposureCents: exposure,
      remainingCents: input.budgetCents - exposure,
    },
    schedule: {
      readyByLocal: input.readyByLocal,
      latestArrivalLocal: input.latestArrivalLocal,
      lastArrivalLocal: fromMinutes(c.lastArrivalMin),
      slackMinutes: c.slackMinutes,
    },
    unresolvedConditions: c.unresolvedConditions,
    fullyPriced: c.fullyPriced,
    changeSummary: { kept, added: [...added, ...requoted], removed, replaced, ...(input.widened ? { widened: input.widened } : {}) },
    evaluation: {
      candidatesChecked: result.candidatesChecked,
      feasibleCandidates: result.feasibleCandidates,
      rejectedByReason: completeRejectCounts(result.rejectedByReason),
      solverMs: result.solverMs,
      scope: "optimal among evaluated candidates only",
    },
    reason: describeChoice(c, result, Boolean(ctx.previous)),
    createdAt: input.createdAt,
  };
  return plan;
}

function describeChoice(c: Candidate, result: SolveResult, repair: boolean): string {
  const names = c.offers.map((o) => o.merchantName).join(" + ");
  if (repair) {
    return `Fewest changes among ${result.feasibleCandidates} feasible of ${result.candidatesChecked} evaluated: ${names}.`.slice(0, 200);
  }
  return `Lowest all-in cost among ${result.feasibleCandidates} feasible of ${result.candidatesChecked} evaluated: ${names}.`.slice(0, 200);
}

export function explainInfeasibility(ctx: SolveContext, result: SolveResult, openGroups: { meals: boolean; drinks: boolean; delivery: boolean }): Infeasibility {
  const budgetOnly = result.candidates.filter((c) => !c.feasible && c.rejects.every((r) => r === "over_budget")).sort(compareFresh);
  const eval_ = { candidatesChecked: result.candidatesChecked, rejectedByReason: completeRejectCounts(result.rejectedByReason), solverMs: result.solverMs };
  const cheapest = budgetOnly[0];
  if (cheapest) {
    const gap = cheapest.exposureCents - ctx.demand.budgetCents;
    return {
      kind: "over_budget",
      summary: `Every valid combination exceeds the budget. Lowest-cost otherwise-valid option is over by ${(gap / 100).toFixed(2)} dollars.`.slice(0, 200),
      details: [
        `Lowest-cost otherwise-valid option: ${cheapest.offers.map((o) => o.merchantName).join(" + ")}.`,
        `Exposure would be ${(cheapest.exposureCents / 100).toFixed(2)} against a ${(ctx.demand.budgetCents / 100).toFixed(2)} budget (includes retained charges and pending refunds).`,
        "Raise the budget or reduce the requirements to continue. Dietary requirements are never relaxed automatically.",
      ],
      cheapestInvalid: {
        totalCents: cheapest.exposureCents,
        budgetGapCents: gap,
        merchants: cheapest.offers.map((o) => o.merchantName),
        failing: cheapest.rejects,
      },
      evaluation: eval_,
    };
  }
  if (!openGroups.meals) {
    return {
      kind: "no_supply",
      summary: "No available meal supplier in the demo catalog can serve this request.",
      details: ["All meal suppliers are unavailable, declined, or cannot meet the quantity.", "No supply is invented to keep the demo moving."],
      evaluation: eval_,
    };
  }
  const timing = result.candidates.filter((c) => !c.feasible && c.rejects.every((r) => r === "arrival_too_late" || r === "pickup_too_late" || r === "over_budget"));
  if (timing.length > 0) {
    return {
      kind: "timing",
      summary: "Every otherwise-valid combination arrives too late for the ready-by time.",
      details: ["Modelled arrival windows and the setup buffer leave no feasible schedule.", "Later ready-by time or earlier delivery slots would be needed."],
      evaluation: eval_,
    };
  }
  const capacityHit = (result.rejectedByReason.capacity_exceeded ?? 0) + (result.rejectedByReason.below_min_order ?? 0) + (result.rejectedByReason.courier_capacity ?? 0);
  return {
    kind: capacityHit > 0 ? "capacity" : "no_supply",
    summary: capacityHit > 0 ? "No combination of available offers covers the required quantities within supplier capacity." : "No combination of available offers covers the requirements.",
    details: Object.entries(result.rejectedByReason).map(([k, v]) => `${k}: ${v} candidates`),
    evaluation: eval_,
  };
}
