/**
 * Hand-built sample runs for the /dev visual harness. Server-only: imported
 * by `src/app/dev/page.tsx` (a server component) so the private catalog
 * never reaches the browser bundle; only the public merchant snapshot does.
 *
 * Figures match LLD §9 (the worked example computed by scripts/simulate.ts):
 * Golden Hour $565.40 + Bodega $147.00 + Pelican $72.00 = $784.40,
 * remaining $215.60, slack 20 min. Every variant is checked with Run.parse.
 */
import {
  RejectCode,
  Run,
  RunEvent,
  type IntegrationStatus,
  type ItemKind,
  type LedgerEntry,
  type NegotiationMessage,
  type Offer,
  type OfferStatus,
  type Plan,
  type RejectCode as RejectCodeT,
  type Requirements,
  type RunEvent as RunEventT,
  type Run as RunT,
  type SimOrder,
} from "@/lib/contracts";
import { PUBLIC_CATALOG } from "@/lib/catalog-public";
import assembledSample from "./assembled.sample.json";

export const SAMPLE_STATES = ["collecting", "confirming", "cleared", "confirmed", "recovered", "infeasible", "assembled"] as const;
export type SampleState = (typeof SAMPLE_STATES)[number];

const T0 = Date.parse("2026-10-16T21:00:00.000Z"); // 2:00 PM America/Los_Angeles
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const RUN_ID = "run_dev_sample";
const PICKUP = "Pickup only: a courier must collect the order.";

const PRESET_TEXT =
  "Dinner for 60 hackathon attendees at our already-booked venue. At least 20 need vegetarian meals; the rest are flexible. Include nonalcoholic drinks, plates, and utensils. Everything ready by 6:30 PM. Maximum $1,000 including all fees and delivery.";

const merchant = (slug: string) => {
  const m = PUBLIC_CATALOG.find((x) => x.id === `m-${slug}`);
  if (!m) throw new Error(`unknown merchant ${slug}`);
  return m;
};

type Line = [sku: string, label: string, kind: ItemKind, qty: number, unitCents: number];

function offer(p: {
  slug: string;
  rv: number;
  revision: number;
  status: OfferStatus;
  lines: Line[];
  fees?: [string, number][];
  delivery: number | null;
  slotId: string;
  time: string;
  pickupBy?: string;
  maxPickups?: number;
  round: 0 | 1 | 2;
  note: string;
  t: number;
}): Offer {
  const m = merchant(p.slug);
  const lines = p.lines.map(([sku, label, kind, qty, unitCents]) => ({ sku, label, kind, qty, unitCents, lineCents: qty * unitCents }));
  const fees = (p.fees ?? []).map(([label, cents]) => ({ label, cents }));
  const totalCents = lines.reduce((s, l) => s + l.lineCents, 0) + fees.reduce((s, f) => s + f.cents, 0) + (p.delivery ?? 0);
  return {
    id: `off_${p.slug}_v${p.rv}`,
    merchantId: m.id,
    merchantName: m.name,
    group: m.group,
    revision: p.revision,
    ...(p.revision > 1 ? { supersedesRevision: p.revision - 1 } : {}),
    status: p.status,
    requestVersion: p.rv,
    lines,
    fees,
    deliveryCents: p.delivery,
    totalCents,
    fulfillment: {
      mode: m.fulfillment.mode,
      slotId: p.slotId,
      timeLocal: p.time,
      ...(p.pickupBy ? { pickupByLocal: p.pickupBy } : {}),
      ...(p.maxPickups !== undefined ? { maxPickups: p.maxPickups } : {}),
    },
    expiresAt: at(p.t + 3 * 3600),
    conditions: m.fulfillment.mode === "pickup_only" ? [PICKUP] : [],
    unpriced: [],
    provenance: { supply: "demo_catalog", reasoning: "local", round: p.round, note: p.note },
    createdAt: at(p.t),
  };
}

// --- Line catalogs ----------------------------------------------------------
const L = {
  juniper: (veg: number, std: number, vu = 1250, su = 1350): Line[] => [
    ["veg-bowl", "Roasted vegetable grain bowl (vegetarian)", "meal_vegetarian", veg, vu],
    ["std-box", "Herb chicken dinner box", "meal_standard", std, su],
  ],
  goldenhour: (veg: number, std: number, vu = 925, su = 1025): Line[] => [
    ["veg-plate", "Black bean & squash taco plate (vegetarian)", "meal_vegetarian", veg, vu],
    ["std-plate", "Carnitas taco plate", "meal_standard", std, su],
  ],
  harbor: (veg: number, std: number, vu = 995, su = 1045): Line[] => [
    ["veg-tray", "Paneer & chickpea curry plate (vegetarian)", "meal_vegetarian", veg, vu],
    ["std-tray", "Lemon herb chicken plate", "meal_standard", std, su],
  ],
  fogline: (n: number, d = 210, p = 45, u = 35): Line[] => [
    ["drink", "Sparkling water & soft drink service (nonalcoholic)", "drink_serving", n, d],
    ["plate", "Compostable plate", "plate", n, p],
    ["utensils", "Utensil set", "utensil_set", n, u],
  ],
  bodega: (n: number): Line[] => [
    ["drink", "Assorted canned soft drinks & water (nonalcoholic)", "drink_serving", n, 175],
    ["plate", "Paper plate", "plate", n, 40],
    ["utensils", "Utensil set", "utensil_set", n, 30],
  ],
  pelican: (): Line[] => [["route-2", "Event run, up to 2 pickups", "delivery_run", 1, 7200]],
  swiftline: (): Line[] => [["route-1", "Event run, 1 pickup", "delivery_run", 1, 4400]],
};

// --- Request v1 offers (60 guests) ---------------------------------------------
function offersV1(stage: "collecting" | "cleared"): Offer[] {
  const round0Open = stage === "collecting";
  const list: Offer[] = [
    offer({ slug: "juniper", rv: 1, revision: 1, status: round0Open ? "open" : "superseded", lines: L.juniper(20, 40), fees: [["Service fee (5%)", 3950]], delivery: 4000, slotId: "arr-1745", time: "17:45", round: 0, note: "Initial quote at list price", t: 5 }),
    offer({ slug: "goldenhour", rv: 1, revision: 1, status: round0Open ? "open" : "superseded", lines: L.goldenhour(20, 40), delivery: null, slotId: "ready-1730", time: "17:30", round: 0, note: "Initial quote at list price", t: 6 }),
    offer({ slug: "fogline", rv: 1, revision: 1, status: round0Open ? "open" : "superseded", lines: L.fogline(60), delivery: 2500, slotId: "arr-1815", time: "18:15", round: 0, note: "Initial quote at list price", t: 7 }),
  ];
  if (stage === "collecting") return list;
  list.push(
    offer({ slug: "bodega", rv: 1, revision: 1, status: "open", lines: L.bodega(60), delivery: null, slotId: "ready-1600", time: "16:00", round: 0, note: "Initial quote at list price", t: 8 }),
    offer({ slug: "pelican", rv: 1, revision: 1, status: "open", lines: L.pelican(), delivery: null, slotId: "run-1750", time: "17:50", pickupBy: "17:15", maxPickups: 2, round: 0, note: "Initial quote at list price", t: 9 }),
    offer({ slug: "swiftline", rv: 1, revision: 1, status: "open", lines: L.swiftline(), delivery: null, slotId: "run-1800", time: "18:00", pickupBy: "17:30", maxPickups: 1, round: 0, note: "Initial quote at list price", t: 10 }),
    offer({ slug: "goldenhour", rv: 1, revision: 2, status: "superseded", lines: L.goldenhour(20, 40), delivery: null, slotId: "ready-1700", time: "17:00", round: 1, note: "Moved to Ready 5:00 PM", t: 12 }),
    offer({ slug: "goldenhour", rv: 1, revision: 3, status: "open", lines: L.goldenhour(20, 40, 879, 974), delivery: null, slotId: "ready-1700", time: "17:00", round: 1, note: "Applied 5% volume discount at ≥60 units", t: 13 }),
    offer({ slug: "fogline", rv: 1, revision: 2, status: "open", lines: L.fogline(60), delivery: 2500, slotId: "arr-1630", time: "16:30", round: 1, note: "Moved to Arrive 4:30 PM", t: 15 }),
    offer({ slug: "juniper", rv: 1, revision: 2, status: "open", lines: L.juniper(20, 40, 1150, 1242), fees: [["Service fee (5%)", 3634]], delivery: 4000, slotId: "arr-1745", time: "17:45", round: 2, note: "Applied 8% volume discount at ≥50 units", t: 17 }),
  );
  return list;
}

const NEGOTIATION_V1: NegotiationMessage[] = [
  { id: "neg_1", round: 1, offerId: "off_goldenhour_v1", merchantId: "m-goldenhour", lever: "earlier_slot", ask: "Ready 17:30 misses the courier pickup window; can it be earlier?", outcome: "revised", reply: "Moved to Ready 5:00 PM.", resultRevision: 2, reasoning: "local" },
  { id: "neg_2", round: 1, offerId: "off_goldenhour_v1", merchantId: "m-goldenhour", lever: "volume_discount", ask: "Volume pricing for 60 units?", outcome: "revised", reply: "Applied a 5% volume discount for 60 units.", resultRevision: 3, reasoning: "local" },
  { id: "neg_3", round: 1, offerId: "off_bodega_v1", merchantId: "m-bodega", lever: "volume_discount", ask: "Volume pricing for 180 units?", outcome: "declined", reply: "Fixed pricing; no volume discount available.", reasoning: "local" },
  { id: "neg_4", round: 1, offerId: "off_fogline_v1", merchantId: "m-fogline", lever: "earlier_slot", ask: "Arrival 18:15 is after the latest arrival; please move earlier.", outcome: "revised", reply: "Moved to Arrive 4:30 PM.", resultRevision: 2, reasoning: "local" },
  { id: "neg_5", round: 1, offerId: "off_fogline_v1", merchantId: "m-fogline", lever: "volume_discount", ask: "Volume pricing for 180 units?", outcome: "declined", reply: "Volume pricing starts at 80 units.", reasoning: "local" },
  { id: "neg_6", round: 2, offerId: "off_juniper_v1", merchantId: "m-juniper", lever: "volume_discount", ask: "Volume pricing for 60 units?", outcome: "revised", reply: "Applied a 8% volume discount for 60 units.", resultRevision: 2, reasoning: "local" },
];

// --- Requirements -------------------------------------------------------------
function requirements(headcount: number, opts: { missingHeadcount?: boolean } = {}): Requirements {
  const fieldStatus: Requirements["fieldStatus"] = {
    objective: "confirmed",
    venue: "assumed",
    timezone: "confirmed",
    eventDate: "confirmed",
    readyBy: "confirmed",
    headcount: opts.missingHeadcount ? "missing" : "confirmed",
    vegetarianMin: "confirmed",
    drinks: "confirmed",
    plates: "confirmed",
    utensils: "confirmed",
    budget: "confirmed",
  };
  return {
    objective: "Dinner",
    venue: { name: "Pier 9 Workshop Hall (fictional demo venue)", zone: "bayfront", fictional: true },
    timezone: "America/Los_Angeles",
    eventDate: "2026-10-16",
    nowLocal: "14:00",
    readyByLocal: "18:30",
    setupBufferMinutes: 20,
    headcount: opts.missingHeadcount ? 1 : headcount,
    vegetarianMin: 20,
    items: { drinks: true, plates: true, utensils: true },
    preferences: ["Nonalcoholic drinks only"],
    budgetCents: 100000,
    fieldStatus,
    assumptions: [
      { field: "venue", note: 'Using the fictional demo venue "Pier 9 Workshop Hall (fictional demo venue)" in zone "bayfront".' },
      { field: "readyBy", note: "A 20-minute setup buffer is applied before the ready-by time." },
    ],
    missing: opts.missingHeadcount ? ["headcount"] : [],
    interpretedBy: "local",
  };
}

// --- Plans --------------------------------------------------------------------
const EVAL_SCOPE = "optimal among evaluated candidates only" as const;
const ITEM_KINDS: ItemKind[] = ["meal_vegetarian", "meal_standard", "drink_serving", "plate", "utensil_set", "delivery_run"];
const REJECT_CODES = RejectCode.options;

/** Zod 4 records keyed by an enum are exhaustive, so every key is present (zeros where unused). */
function cov(partial: Partial<Record<ItemKind, number>>): Record<ItemKind, number> {
  return Object.fromEntries(ITEM_KINDS.map((k) => [k, partial[k] ?? 0])) as Record<ItemKind, number>;
}
function rej(partial: Partial<Record<RejectCodeT, number>>): Record<RejectCodeT, number> {
  return Object.fromEntries(REJECT_CODES.map((k) => [k, partial[k] ?? 0])) as Record<RejectCodeT, number>;
}

function plan1(status: Plan["status"]): Plan {
  return {
    revision: 1,
    requestVersion: 1,
    status,
    selections: [
      { offerId: "off_bodega_v1", offerRevision: 1, merchantId: "m-bodega", merchantName: "Bodega Marquez", group: "drinks_consumables", totalCents: 14700, coverage: cov({ drink_serving: 60, plate: 60, utensil_set: 60 }), change: "added" },
      { offerId: "off_goldenhour_v1", offerRevision: 3, merchantId: "m-goldenhour", merchantName: "Golden Hour Taqueria", group: "meals", totalCents: 56540, coverage: cov({ meal_vegetarian: 20, meal_standard: 40 }), change: "added" },
      { offerId: "off_pelican_v1", offerRevision: 1, merchantId: "m-pelican", merchantName: "Pelican Couriers", group: "delivery", totalCents: 7200, coverage: cov({ delivery_run: 1 }), deliversFor: ["off_bodega_v1", "off_goldenhour_v1"], change: "added" },
    ],
    coverage: {
      meal_vegetarian: { required: 20, supplied: 20 },
      meal_standard: { required: 40, supplied: 40 },
      drink_serving: { required: 60, supplied: 60 },
      plate: { required: 60, supplied: 60 },
      utensil_set: { required: 60, supplied: 60 },
      delivery_run: { required: 0, supplied: 1 },
    },
    totals: { goodsCents: 71240, feesCents: 0, deliveryCents: 7200, totalCents: 78440 },
    budget: { budgetCents: 100000, planCents: 78440, retainedCents: 0, pendingRefundCents: 0, exposureCents: 78440, remainingCents: 21560 },
    schedule: { readyByLocal: "18:30", latestArrivalLocal: "18:10", lastArrivalLocal: "17:50", slackMinutes: 20 },
    unresolvedConditions: [PICKUP, PICKUP],
    fullyPriced: true,
    changeSummary: { kept: [], added: [], removed: [], replaced: [] },
    evaluation: {
      candidatesChecked: 41,
      feasibleCandidates: 4,
      rejectedByReason: rej({ dietary_shortfall: 14, incomplete_coverage: 25, needs_delivery: 11, over_budget: 10, courier_capacity: 1, delivery_unused: 13 }),
      solverMs: 2,
      scope: EVAL_SCOPE,
    },
    reason: "Lowest all-in cost among 4 feasible of 41 evaluated: Bodega Marquez + Golden Hour Taqueria + Pelican Couriers.",
    createdAt: at(20),
  };
}

function plan2(status: Plan["status"]): Plan {
  return {
    revision: 2,
    basedOnRevision: 1,
    requestVersion: 1,
    status,
    selections: [
      { offerId: "off_bodega_v1", offerRevision: 1, merchantId: "m-bodega", merchantName: "Bodega Marquez", group: "drinks_consumables", totalCents: 14700, coverage: cov({ drink_serving: 60, plate: 60, utensil_set: 60 }), change: "kept" },
      { offerId: "off_juniper_v1", offerRevision: 2, merchantId: "m-juniper", merchantName: "Juniper & Rye Catering", group: "meals", totalCents: 80314, coverage: cov({ meal_vegetarian: 20, meal_standard: 40 }), change: "replaced", replacesMerchantId: "m-goldenhour" },
      { offerId: "off_swiftline_v1", offerRevision: 1, merchantId: "m-swiftline", merchantName: "Swiftline Runners", group: "delivery", totalCents: 4400, coverage: cov({ delivery_run: 1 }), deliversFor: ["off_bodega_v1"], change: "replaced", replacesMerchantId: "m-pelican" },
    ],
    coverage: {
      meal_vegetarian: { required: 20, supplied: 20 },
      meal_standard: { required: 40, supplied: 40 },
      drink_serving: { required: 60, supplied: 60 },
      plate: { required: 60, supplied: 60 },
      utensil_set: { required: 60, supplied: 60 },
      delivery_run: { required: 0, supplied: 1 },
    },
    totals: { goodsCents: 87380, feesCents: 3634, deliveryCents: 8400, totalCents: 99414 },
    budget: { budgetCents: 100000, planCents: 99414, retainedCents: 0, pendingRefundCents: 0, exposureCents: 99414, remainingCents: 586 },
    schedule: { readyByLocal: "18:30", latestArrivalLocal: "18:10", lastArrivalLocal: "18:00", slackMinutes: 10 },
    unresolvedConditions: [PICKUP],
    fullyPriced: true,
    changeSummary: {
      kept: ["Bodega Marquez"],
      added: [],
      removed: [],
      replaced: [
        { from: "Golden Hour Taqueria", to: "Juniper & Rye Catering", why: "Supplier cancelled (simulated disruption)" },
        { from: "Pelican Couriers", to: "Swiftline Runners", why: "Keeping Pelican would exceed the budget by $22.14" },
      ],
      widened: "Keeping Pelican Couriers would exceed the budget by $22.14; Swiftline Runners replaces it.",
    },
    evaluation: {
      candidatesChecked: 25,
      feasibleCandidates: 1,
      rejectedByReason: rej({ dietary_shortfall: 14, incomplete_coverage: 18, needs_delivery: 4, over_budget: 5, delivery_unused: 12 }),
      solverMs: 1,
      scope: EVAL_SCOPE,
    },
    reason: "Fewest changes among 1 feasible of 25 evaluated: Bodega Marquez + Juniper & Rye Catering + Swiftline Runners.",
    createdAt: at(122),
  };
}

// --- Events -------------------------------------------------------------------
type Ev = [t: number, type: RunEventT["type"], summary: string, payload?: Record<string, unknown>];

function events(list: Ev[]): RunEventT[] {
  return list.map(([t, type, summary, payload], i) => ({
    id: `evt_${RUN_ID}_${i + 1}`,
    runId: RUN_ID,
    seq: i + 1,
    type,
    at: at(t),
    summary,
    payload: payload ?? {},
  }));
}

function byKey(offers: Offer[], id: string, rev: number): Offer {
  const o = offers.find((x) => x.id === id && x.revision === rev);
  if (!o) throw new Error(`missing ${id}@${rev}`);
  return o;
}

function collectEvents(offers: Offer[], full: boolean): Ev[] {
  const list: Ev[] = [
    [0, "run.created", "Preset run created with the editable demo request", { requestVersion: 1 }],
    [1, "request.submitted", "Request submitted (request v1)", { requestVersion: 1 }],
    [1, "requirements.extracted", "Requirements: 60 guests, ≥20 vegetarian, ready 6:30 PM, budget $1,000.00", { interpretedBy: "local", missing: [] }],
    [3, "requirements.confirmed", "Requirements confirmed by the organizer", { edits: {} }],
    [3, "market.opened", "Market opened to 7 demo suppliers (paced for readability)", { suppliers: 7, paceMs: 350 }],
    [4, "supplier.skipped", "Harbor Kitchen Collective declined: minimum order 75 meals > 60 needed", { merchantId: "m-harbor", reason: "Minimum order 75 meals > 60 needed", requestVersion: 1 }],
    [5, "offer.received", "Juniper & Rye Catering quoted $869.50 · arrives 5:45 PM", { offer: byKey(offers, "off_juniper_v1", 1) }],
    [6, "offer.received", "Golden Hour Taqueria quoted $595.00 · ready 5:30 PM (pickup)", { offer: byKey(offers, "off_goldenhour_v1", 1) }],
    [7, "offer.received", "Fogline Beverage Co. quoted $199.00 · arrives 6:15 PM", { offer: byKey(offers, "off_fogline_v1", 1) }],
  ];
  if (!full) return list;
  list.push(
    [8, "offer.received", "Bodega Marquez quoted $147.00 · ready 4:00 PM (pickup)", { offer: byKey(offers, "off_bodega_v1", 1) }],
    [9, "offer.received", "Pelican Couriers quoted $72.00 · two pickups by 5:15 PM", { offer: byKey(offers, "off_pelican_v1", 1) }],
    [10, "offer.received", "Swiftline Runners quoted $44.00 · one pickup by 5:30 PM", { offer: byKey(offers, "off_swiftline_v1", 1) }],
    [11, "negotiation.requested", "Round 1: asked Golden Hour Taqueria for an earlier ready time", { offerId: "off_goldenhour_v1", lever: "earlier_slot", round: 1 }],
    [12, "offer.revised", "Golden Hour Taqueria r2: ready 5:00 PM", { offerId: "off_goldenhour_v1", from: 1, to: 2 }],
    [13, "offer.revised", "Golden Hour Taqueria r3: 5% volume price, $565.40", { offerId: "off_goldenhour_v1", from: 2, to: 3 }],
    [14, "offer.declined", "Bodega Marquez declined a volume discount: fixed pricing", { offerId: "off_bodega_v1", lever: "volume_discount" }],
    [15, "offer.revised", "Fogline Beverage Co. r2: arrives 4:30 PM", { offerId: "off_fogline_v1", from: 1, to: 2 }],
    [17, "offer.revised", "Round 2: Juniper & Rye Catering r2, 8% volume price, $803.14", { offerId: "off_juniper_v1", from: 1, to: 2 }],
    [18, "clearing.started", "Clearing started on 6 open offers", {}],
    [20, "clearing.evaluated", "41 candidates checked · 4 feasible · 2 ms", { candidatesChecked: 41, feasibleCandidates: 4, solverMs: 2 }],
    [20, "plan.proposed", "Plan r1 proposed: $784.40", { planRevision: 1, totalCents: 78440 }],
    [20, "market.cleared", "Market cleared: $784.40 total, $215.60 remaining, 20 min slack", { totalCents: 78440, slackMinutes: 20 }],
  );
  return list;
}

function approvalEvents(planRevision: number, t: number, orders: { id: string; name: string; cents: number }[]): Ev[] {
  const list: Ev[] = [[t, "plan.approved", `Plan r${planRevision} approved by the organizer`, { planRevision }]];
  for (const o of orders) list.push([t, "order.simulated_placed", `Simulated order ${o.id} placed with ${o.name}`, { orderId: o.id, amountCents: o.cents }]);
  for (const o of orders) list.push([t + 1, "order.simulated_confirmed", `Simulated order ${o.id} confirmed`, { orderId: o.id }]);
  return list;
}

// --- Orders & ledger ------------------------------------------------------------
function order(id: string, slug: string, offerId: string, offerRevision: number, planRevision: number, cents: number, t: number, status: SimOrder["status"] = "simulated_confirmed", cancellation?: SimOrder["cancellation"]): SimOrder {
  const m = merchant(slug);
  return { id, merchantId: m.id, merchantName: m.name, offerId, offerRevision, planRevision, amountCents: cents, status, simulated: true, placedAt: at(t), ...(cancellation ? { cancellation } : {}) };
}

const ledger = (rows: [kind: LedgerEntry["kind"], orderId: string, cents: number, t: number][]): LedgerEntry[] =>
  rows.map(([kind, orderId, cents, t], i) => ({ id: `led_${i + 1}`, kind, orderId, cents, at: at(t), simulated: true }));

// --- Base run -------------------------------------------------------------------
function base(): RunT {
  return {
    id: RUN_ID,
    createdAt: at(0),
    updatedAt: at(0),
    version: 1,
    requestVersion: 1,
    phase: "draft",
    reasoning: "local",
    request: { text: PRESET_TEXT, eventDate: "2026-10-16", timezone: "America/Los_Angeles", nowLocal: "14:00" },
    requirements: null,
    merchants: PUBLIC_CATALOG,
    availability: {},
    offers: [],
    negotiation: [],
    plans: [],
    currentPlanRevision: null,
    approvals: [],
    orders: [],
    ledger: [],
    disruptions: [],
    infeasibility: null,
    job: null,
    lastSeq: 0,
    modelCalls: 0,
    lastError: null,
  };
}

function build(state: SampleState): { run: RunT; events: RunEventT[] } {
  if (state === "assembled") {
    // Captured from the real modules: createService({ store: openStore(":memory:"), clock: fixedClock(),
    // provider: localProvider(), paceMs: 0 }) → createPresetRun → submitRequest(REQUESTS.assembly)
    // → confirmRequirements → drain. 130 guests at $2,600: Harbor 120 + Golden Hour 20 (top-up)
    // + Bodega + Pelican = $1,858.02. Public merchant profiles only; validated below.
    return { run: assembledSample.run as unknown as RunT, events: assembledSample.events as unknown as RunEventT[] };
  }
  const run = base();
  if (state === "confirming") {
    const text = PRESET_TEXT.replace("Dinner for 60 hackathon attendees", "Dinner for our hackathon attendees");
    run.request.text = text;
    run.phase = "confirming";
    run.requirements = requirements(60, { missingHeadcount: true });
    const evs = events([
      [0, "run.created", "Preset run created with the editable demo request"],
      [1, "request.submitted", "Request submitted (request v1)"],
      [1, "requirements.extracted", "Requirements extracted; headcount is missing", { missing: ["headcount"] }],
    ]);
    return { run: { ...run, version: 3, lastSeq: evs.length, updatedAt: at(1) }, events: evs };
  }

  run.requirements = requirements(60);
  if (state === "collecting") {
    const offers = offersV1("collecting");
    run.phase = "collecting";
    run.offers = offers;
    run.job = { id: "job_collect_1", kind: "collect", requestVersion: 1, startedAt: at(3) };
    const evs = events(collectEvents(offers, false));
    return { run: { ...run, version: 9, lastSeq: evs.length, updatedAt: at(7) }, events: evs };
  }

  const offers = offersV1("cleared");
  run.offers = offers;
  run.negotiation = NEGOTIATION_V1;
  const cleared = collectEvents(offers, true);

  if (state === "cleared") {
    run.phase = "proposed";
    run.plans = [plan1("proposed")];
    run.currentPlanRevision = 1;
    const evs = events(cleared);
    return { run: { ...run, version: evs.length, lastSeq: evs.length, updatedAt: at(20) }, events: evs };
  }

  // Approved plan r1 and its simulated orders.
  const o1 = [
    order("ord_1_bodega", "bodega", "off_bodega_v1", 1, 1, 14700, 40),
    order("ord_1_goldenhour", "goldenhour", "off_goldenhour_v1", 3, 1, 56540, 40),
    order("ord_1_pelican", "pelican", "off_pelican_v1", 1, 1, 7200, 40),
  ];
  run.approvals = [{ id: "apr_1", planRevision: 1, authorizedCents: 78440, approvedAt: at(40), idempotencyKey: "dev-sample-approve-r1" }];
  const approved1 = approvalEvents(1, 40, o1.map((o) => ({ id: o.id, name: o.merchantName, cents: o.amountCents })));

  if (state === "confirmed") {
    run.phase = "simulated_confirmed";
    run.plans = [plan1("approved")];
    run.currentPlanRevision = 1;
    run.orders = o1;
    run.ledger = ledger([
      ["charge", "ord_1_bodega", 14700, 40],
      ["charge", "ord_1_goldenhour", 56540, 40],
      ["charge", "ord_1_pelican", 7200, 40],
    ]);
    const evs = events([...cleared, ...approved1]);
    return { run: { ...run, version: evs.length, lastSeq: evs.length, updatedAt: at(41) }, events: evs };
  }

  // Golden Hour cancels; repair proposes plan r2.
  const cancelGH: SimOrder["cancellation"] = { reason: "Supplier cancelled (simulated disruption)", retainedCents: 0, refundCents: 56540, refundStatus: "settled", cancelledAt: at(120) };
  run.availability = { "m-goldenhour": { available: false, reason: "Supplier cancelled (simulated disruption)" } };
  run.offers = offers.map((o) => (o.id === "off_goldenhour_v1" && o.status === "open" ? { ...o, status: "withdrawn" as const } : o));
  run.disruptions = [{ id: "dis_1", at: at(120), input: { type: "supplier_unavailable", merchantId: "m-goldenhour" }, summary: "Golden Hour Taqueria cancelled (simulated)" }];
  const disruptionEvents: Ev[] = [
    [120, "disruption.injected", "Disruption: Golden Hour Taqueria is unavailable", { disruption: run.disruptions[0] }],
    [120, "offer.withdrawn", "Golden Hour Taqueria r3 withdrawn", { offerId: "off_goldenhour_v1", revision: 3 }],
    [120, "order.cancelled", "Simulated order ord_1_goldenhour cancelled · full refund $565.40", { orderId: "ord_1_goldenhour", refundCents: 56540, retainedCents: 0 }],
    [120, "refund.settled", "Simulated refund $565.40 settled immediately", { orderId: "ord_1_goldenhour", cents: 56540 }],
    [121, "repair.started", "Repair started: keep what still works, re-solve the rest", { previousPlanRevision: 1 }],
    [122, "clearing.evaluated", "25 candidates checked · 1 feasible · 1 ms (repair ranking)", { candidatesChecked: 25, feasibleCandidates: 1, solverMs: 1 }],
    [122, "plan.repaired", "Plan r2 proposed: $994.14 · Bodega kept, 2 replacements · needs approval", { planRevision: 2, totalCents: 99414 }],
  ];

  if (state === "recovered") {
    run.phase = "needs_approval";
    run.plans = [plan1("approved"), plan2("proposed")];
    run.currentPlanRevision = 2;
    run.orders = [o1[0]!, { ...o1[1]!, status: "cancelled", cancellation: cancelGH }, o1[2]!];
    run.ledger = ledger([
      ["charge", "ord_1_bodega", 14700, 40],
      ["charge", "ord_1_goldenhour", 56540, 40],
      ["charge", "ord_1_pelican", 7200, 40],
      ["refund_settled", "ord_1_goldenhour", 56540, 120],
    ]);
    const evs = events([...cleared, ...approved1, ...disruptionEvents]);
    return { run: { ...run, version: evs.length, lastSeq: evs.length, updatedAt: at(122) }, events: evs };
  }

  // infeasible: plan r2 approved, then headcount 60 → 85 at a $1,000 budget.
  const o2 = [
    order("ord_2_juniper", "juniper", "off_juniper_v1", 2, 2, 80314, 160),
    order("ord_2_swiftline", "swiftline", "off_swiftline_v1", 1, 2, 4400, 160),
  ];
  const cancelPelican: SimOrder["cancellation"] = { reason: "Dropped by approved plan r2", retainedCents: 0, refundCents: 7200, refundStatus: "settled", cancelledAt: at(160) };
  run.approvals.push({ id: "apr_2", planRevision: 2, authorizedCents: 99414, approvedAt: at(160), idempotencyKey: "dev-sample-approve-r2" });
  run.requestVersion = 2;
  run.requirements = requirements(85);
  run.disruptions.push({ id: "dis_2", at: at(240), input: { type: "headcount_changed", headcount: 85 }, summary: "Headcount changed 60 → 85" });
  const v1Superseded = run.offers.map((o) => (o.status === "open" ? { ...o, status: "superseded" as const } : o));
  const v2: Offer[] = [
    offer({ slug: "juniper", rv: 2, revision: 1, status: "open", lines: L.juniper(20, 65), fees: [["Service fee (5%)", 5638]], delivery: 4000, slotId: "arr-1745", time: "17:45", round: 0, note: "Re-quoted at 85 guests", t: 241 }),
    offer({ slug: "harbor", rv: 2, revision: 1, status: "superseded", lines: L.harbor(20, 65), fees: [["Service fee (8%)", 7026]], delivery: 0, slotId: "arr-1800", time: "18:00", round: 0, note: "Quoted at 85 guests (minimum now met)", t: 242 }),
    offer({ slug: "fogline", rv: 2, revision: 1, status: "superseded", lines: L.fogline(85), delivery: 2500, slotId: "arr-1815", time: "18:15", round: 0, note: "Re-quoted at 85 guests", t: 243 }),
    offer({ slug: "bodega", rv: 2, revision: 1, status: "open", lines: L.bodega(85), delivery: null, slotId: "ready-1600", time: "16:00", round: 0, note: "Re-quoted at 85 guests", t: 244 }),
    offer({ slug: "pelican", rv: 2, revision: 1, status: "open", lines: L.pelican(), delivery: null, slotId: "run-1750", time: "17:50", pickupBy: "17:15", maxPickups: 2, round: 0, note: "Unchanged courier quote", t: 245 }),
    offer({ slug: "swiftline", rv: 2, revision: 1, status: "open", lines: L.swiftline(), delivery: null, slotId: "run-1800", time: "18:00", pickupBy: "17:30", maxPickups: 1, round: 0, note: "Unchanged courier quote", t: 245 }),
    offer({ slug: "harbor", rv: 2, revision: 2, status: "open", lines: L.harbor(20, 65, 935, 982), fees: [["Service fee (8%)", 6602]], delivery: 0, slotId: "arr-1800", time: "18:00", round: 1, note: "Applied 6% volume discount at ≥80 units", t: 247 }),
    offer({ slug: "fogline", rv: 2, revision: 2, status: "superseded", lines: L.fogline(85), delivery: 2500, slotId: "arr-1630", time: "16:30", round: 1, note: "Moved to Arrive 4:30 PM", t: 248 }),
    offer({ slug: "fogline", rv: 2, revision: 3, status: "open", lines: L.fogline(85, 200, 43, 33), delivery: 2500, slotId: "arr-1630", time: "16:30", round: 1, note: "Applied 5% volume discount at ≥80 units", t: 249 }),
  ];
  run.offers = [...v1Superseded, ...v2];
  run.phase = "no_feasible_plan";
  run.plans = [plan1("superseded"), plan2("approved")];
  run.currentPlanRevision = 2;
  run.orders = [
    o1[0]!,
    { ...o1[1]!, status: "cancelled", cancellation: cancelGH },
    { ...o1[2]!, status: "cancelled", cancellation: cancelPelican },
    ...o2,
  ];
  run.ledger = ledger([
    ["charge", "ord_1_bodega", 14700, 40],
    ["charge", "ord_1_goldenhour", 56540, 40],
    ["charge", "ord_1_pelican", 7200, 40],
    ["refund_settled", "ord_1_goldenhour", 56540, 120],
    ["charge", "ord_2_juniper", 80314, 160],
    ["charge", "ord_2_swiftline", 4400, 160],
    ["refund_settled", "ord_1_pelican", 7200, 160],
  ]);
  run.infeasibility = {
    kind: "over_budget",
    summary: "Every valid combination exceeds the budget. Lowest-cost otherwise-valid option is over by 143.57 dollars.",
    details: [
      "Lowest-cost otherwise-valid option: Bodega Marquez + Harbor Kitchen Collective + Swiftline Runners.",
      "Exposure would be 1143.57 against a 1000.00 budget (includes retained charges and pending refunds).",
      "Raise the budget or reduce the requirements to continue. Dietary requirements are never relaxed automatically.",
    ],
    cheapestInvalid: { totalCents: 114357, budgetGapCents: 14357, merchants: ["Bodega Marquez", "Harbor Kitchen Collective", "Swiftline Runners"], failing: ["over_budget"] },
    evaluation: {
      candidatesChecked: 41,
      rejectedByReason: rej({ dietary_shortfall: 14, incomplete_coverage: 25, needs_delivery: 7, over_budget: 24, delivery_unused: 19 }),
      solverMs: 1,
    },
  };
  const approved2: Ev[] = [
    [160, "plan.approved", "Plan r2 approved by the organizer", { planRevision: 2 }],
    [160, "order.cancelled", "Simulated order ord_1_pelican cancelled (dropped) · refund $72.00 settled", { orderId: "ord_1_pelican" }],
    [160, "order.simulated_placed", "Simulated order ord_2_juniper placed with Juniper & Rye Catering", { orderId: "ord_2_juniper" }],
    [160, "order.simulated_placed", "Simulated order ord_2_swiftline placed with Swiftline Runners", { orderId: "ord_2_swiftline" }],
    [161, "order.simulated_confirmed", "Simulated orders for plan r2 confirmed; Bodega order kept", { orderIds: ["ord_2_juniper", "ord_2_swiftline"] }],
    [240, "disruption.injected", "Disruption: headcount changed 60 → 85", { disruption: run.disruptions[1] }],
    [241, "offer.requoted", "Juniper & Rye Catering re-quoted at 85 guests: $1,223.88", { offerId: "off_juniper_v2" }],
    [242, "offer.received", "Harbor Kitchen Collective quoted $948.51 (minimum now met)", { offerId: "off_harbor_v2" }],
    [244, "offer.requoted", "Bodega Marquez re-quoted at 85 guests: $208.25", { offerId: "off_bodega_v2" }],
    [247, "offer.revised", "Harbor Kitchen Collective r2: 6% volume price, $891.32", { offerId: "off_harbor_v2", from: 1, to: 2 }],
    [249, "offer.revised", "Fogline Beverage Co. r3: arrives 4:30 PM, 5% volume price, $259.60", { offerId: "off_fogline_v2", from: 2, to: 3 }],
    [250, "clearing.evaluated", "41 candidates checked · 0 feasible · 1 ms", { candidatesChecked: 41, feasibleCandidates: 0, solverMs: 1 }],
    [250, "plan.infeasible", "No feasible plan: closest package is $143.57 over budget", { infeasibility: run.infeasibility }],
  ];
  const evs = events([...cleared, ...approved1, ...disruptionEvents, ...approved2]);
  return { run: { ...run, version: evs.length, lastSeq: evs.length, updatedAt: at(250) }, events: evs };
}

export const SAMPLE_STATUS: IntegrationStatus = {
  reasoning: { mode: "local", provider: "Local rules", verified: true },
  supply: "Fictional demo catalog",
  coordination: "Local transport",
  execution: "Simulated orders",
  tavily: { connected: false, note: "Not connected — requires TAVILY_API_KEY" },
  zoowork: { connected: false, note: "Not connected — requires ZOOWORK_API_KEY and a funded ZooWork project (Developer Preview)" },
  band: { connected: false, note: "Not connected — requires a BAND Remote Agent (agent_id + api_key from app.band.ai)" },
  paceMs: 350,
};

/** Builds a sample run and validates it (and its events) against the shared contracts. */
export function sampleRun(state: SampleState = "cleared"): { run: RunT; events: RunEventT[]; status: IntegrationStatus } {
  const { run, events: evs } = build(state);
  return { run: Run.parse(run), events: evs.map((e) => RunEvent.parse(e)), status: SAMPLE_STATUS };
}
