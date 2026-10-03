/**
 * Shared, deterministic scenario builders for the pure-module unit tests.
 *
 * Mirrors the approach of scripts/simulate.ts: derive demand from interpreted
 * requirements, quote every available merchant, run solver + buyer + seller
 * negotiation rounds, and expose every intermediate result. No clock reads,
 * no randomness, no network: all timestamps derive from FIXED_NOW_ISO.
 */
import { planRound, type CounterRequest, type PlanRound } from "../src/lib/buyer";
import { CATALOG, toPublic } from "../src/lib/catalog";
import type {
  Availability,
  CancellationTerms,
  LedgerEntry,
  Merchant,
  Offer,
  OfferLine,
  PlanSelection,
  Requirements,
  SimOrder,
} from "../src/lib/contracts";
import { FIXED_NOW_ISO, REQUESTS } from "../src/lib/fixtures";
import { interpretLocal } from "../src/lib/interpret";
import { quote, respond, type QuoteContext } from "../src/lib/seller";
import {
  deriveDemand,
  solve,
  validateCandidate,
  type Candidate,
  type Demand,
  type PreviousState,
  type SolveContext,
  type SolveResult,
} from "../src/lib/solver";

export { FIXED_NOW_ISO };

/** Narrow a possibly-missing value (noUncheckedIndexedAccess friendly), failing loudly in tests. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present`);
  return value;
}

/** ISO timestamp `ms` after the fixed test clock. */
export function atOffset(ms: number): string {
  return new Date(Date.parse(FIXED_NOW_ISO) + ms).toISOString();
}

/** Binomial coefficient, for asserting candidate-enumeration counts. */
export function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

// ---------------------------------------------------------------------------
// Requirements / catalog helpers
// ---------------------------------------------------------------------------

export interface RequirementOverrides {
  headcount?: number;
  vegetarianMin?: number;
  budgetCents?: number;
  readyByLocal?: string;
  nowLocal?: string;
  items?: Partial<Requirements["items"]>;
}

/** Interpreted preset requirements (60 attendees, 20 vegetarian, 18:30, $1,000), optionally overridden. */
export function presetRequirements(overrides: RequirementOverrides = {}): Requirements {
  const base = interpretLocal(REQUESTS.preset);
  const { items, ...rest } = overrides;
  return { ...base, ...rest, items: { ...base.items, ...items } };
}

export function catalogMerchant(id: string): Merchant {
  const m = CATALOG.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown catalog merchant ${id}`);
  return m;
}

/** A deep copy of a catalog merchant with a patched top level / policy, for synthetic what-if merchants. */
export function tweakMerchant(id: string, patch: Partial<Omit<Merchant, "policy">> & { policy?: Partial<Merchant["policy"]> }): Merchant {
  const base = structuredClone(catalogMerchant(id));
  const { policy, ...rest } = patch;
  return { ...base, ...rest, policy: { ...base.policy, ...(policy ?? {}) } };
}

export function qctxFor(demand: Demand, over: Partial<QuoteContext> = {}): QuoteContext {
  return { demand, requestVersion: 1, nowIso: FIXED_NOW_ISO, reasoning: "local", ...over };
}

/** Quote one merchant and return its offer (throws if the merchant skips). */
export function quoteOffer(merchantId: string, demand: Demand, over: Partial<QuoteContext> = {}, merchant?: Merchant): Offer {
  const r = quote(merchant ?? catalogMerchant(merchantId), qctxFor(demand, over));
  if (r.kind !== "offer") throw new Error(`${merchantId} skipped: ${r.reason}`);
  return r.offer;
}

// ---------------------------------------------------------------------------
// Offer helpers
// ---------------------------------------------------------------------------

export function latestOffer(offers: Offer[], merchantId: string): Offer {
  const mine = offers.filter((o) => o.merchantId === merchantId).sort((a, b) => b.revision - a.revision);
  const o = mine[0];
  if (!o) throw new Error(`No offer for ${merchantId}`);
  return o;
}

export function offerRevision(offers: Offer[], merchantId: string, revision: number): Offer {
  const o = offers.find((x) => x.merchantId === merchantId && x.revision === revision);
  if (!o) throw new Error(`No offer for ${merchantId} r${revision}`);
  return o;
}

export function cloneOffer(offer: Offer, patch: Partial<Offer> = {}): Offer {
  return { ...structuredClone(offer), ...patch };
}

/** Replace an offer's lines (recomputing line, fee-free goods and total) so tests can fabricate quantities. */
export function withLines(offer: Offer, lines: Array<Pick<OfferLine, "kind" | "qty"> & Partial<OfferLine>>, patch: Partial<Offer> = {}): Offer {
  const built: OfferLine[] = lines.map((l, i) => {
    const unitCents = l.unitCents ?? 100;
    return { sku: l.sku ?? `sku-${i}`, label: l.label ?? `Line ${i}`, kind: l.kind, qty: l.qty, unitCents, lineCents: unitCents * l.qty };
  });
  const goods = built.reduce((s, l) => s + l.lineCents, 0);
  return { ...structuredClone(offer), lines: built, fees: [], deliveryCents: offer.deliveryCents === null ? null : 0, totalCents: goods, ...patch };
}

/** Offers a plan could select: latest open revision per merchant. */
export function openOffers(offers: Offer[]): Offer[] {
  const best = new Map<string, Offer>();
  for (const o of offers) {
    const cur = best.get(o.id);
    if (!cur || o.revision > cur.revision) best.set(o.id, o);
  }
  return [...best.values()].filter((o) => o.status === "open");
}

export function groupsOpen(offers: Offer[], availability: Record<string, Availability> = {}): { meals: boolean; drinks: boolean; delivery: boolean } {
  const live = openOffers(offers).filter((o) => availability[o.merchantId]?.available !== false);
  return {
    meals: live.some((o) => o.group === "meals"),
    drinks: live.some((o) => o.group === "drinks_consumables"),
    delivery: live.some((o) => o.group === "delivery"),
  };
}

// ---------------------------------------------------------------------------
// Orders and ledger helpers
// ---------------------------------------------------------------------------

export function selectionsFor(offers: Offer[]): PlanSelection[] {
  return offers.map((o) => ({
    offerId: o.id,
    offerRevision: o.revision,
    merchantId: o.merchantId,
    merchantName: o.merchantName,
    group: o.group,
    totalCents: o.totalCents,
    coverage: {} as PlanSelection["coverage"],
    change: "added",
  }));
}

export function ordersFor(offers: Offer[], planRevision = 1, status: SimOrder["status"] = "simulated_confirmed"): SimOrder[] {
  return offers.map((o) => makeOrder({ id: `ord_${planRevision}_${o.merchantId.replace(/^m-/, "")}`, merchantId: o.merchantId, merchantName: o.merchantName, offerId: o.id, offerRevision: o.revision, amountCents: o.totalCents, planRevision, status }));
}

export function makeOrder(p: { id: string; merchantId: string; merchantName?: string; offerId?: string; offerRevision?: number; amountCents: number; planRevision?: number; status?: SimOrder["status"] }): SimOrder {
  return {
    id: p.id,
    merchantId: p.merchantId,
    merchantName: p.merchantName ?? p.merchantId,
    offerId: p.offerId ?? `off_${p.merchantId.replace(/^m-/, "")}_v1`,
    offerRevision: p.offerRevision ?? 1,
    planRevision: p.planRevision ?? 1,
    amountCents: p.amountCents,
    status: p.status ?? "simulated_confirmed",
    simulated: true,
    placedAt: FIXED_NOW_ISO,
  };
}

let ledgerSeq = 0;
export function makeLedger(kind: LedgerEntry["kind"], orderId: string, cents: number): LedgerEntry {
  ledgerSeq += 1;
  return { id: `led_${ledgerSeq}`, kind, orderId, cents, at: FIXED_NOW_ISO, simulated: true };
}

/** Ledger rows a cancellation under `terms` leaves behind (charge + retained + pending/settled refund). */
export function cancellationLedger(orderId: string, amountCents: number, retainedCents: number, refundCents: number, refundStatus: "settled" | "pending" | "none"): LedgerEntry[] {
  const rows: LedgerEntry[] = [makeLedger("charge", orderId, amountCents)];
  if (retainedCents > 0) rows.push(makeLedger("retained", orderId, retainedCents));
  if (refundStatus === "pending") rows.push(makeLedger("refund_pending", orderId, refundCents));
  if (refundStatus === "settled") rows.push(makeLedger("refund_settled", orderId, refundCents));
  return rows;
}

export function termsLookup(merchants: Merchant[] = CATALOG): (merchantId: string) => CancellationTerms | undefined {
  return (id) => merchants.find((m) => m.id === id)?.cancellation;
}

// ---------------------------------------------------------------------------
// Market simulation (quote -> negotiation rounds -> solve)
// ---------------------------------------------------------------------------

export interface MarketOptions extends RequirementOverrides {
  requirements?: Requirements;
  availability?: Record<string, Availability>;
  merchants?: Merchant[];
  previous?: PreviousState;
  sunkCents?: number;
  requestVersion?: number;
  nowIso?: string;
  /** Negotiation rounds to run after the initial quote (0..2). Default 2. */
  rounds?: number;
}

export interface TranscriptEntry {
  round: number;
  request: CounterRequest;
  merchantName: string;
  outcome: "revised" | "declined";
  reply: string;
  /** The new offer revision when the outcome is "revised". */
  offer?: Offer;
}

export interface Market {
  requirements: Requirements;
  demand: Demand;
  qctx: QuoteContext;
  merchants: Merchant[];
  availability: Record<string, Availability>;
  /** Every revision of every offer, in creation order. Superseded revisions keep status "superseded". */
  offers: Offer[];
  skipped: Record<string, string>;
  ctx: SolveContext;
  /** solves[0] is the initial quote, solves[n] follows negotiation round n. */
  solves: SolveResult[];
  /** roundPlans[n-1] is the request plan for round n. */
  roundPlans: PlanRound[];
  transcript: TranscriptEntry[];
  asked: Set<string>;
  final: SolveResult;
  latest: (merchantId: string) => Offer;
}

export function runMarket(opts: MarketOptions = {}): Market {
  const { requirements: baseReq, availability: availIn, merchants = CATALOG, previous, sunkCents = 0, requestVersion = 1, nowIso = FIXED_NOW_ISO, rounds = 2, ...overrides } = opts;
  const requirements = baseReq ? { ...baseReq, ...stripUndefined(overrides), items: { ...baseReq.items, ...overrides.items } } : presetRequirements(overrides);
  const availability: Record<string, Availability> = { ...(availIn ?? {}) };
  const demand = deriveDemand(requirements);
  const qctx = qctxFor(demand, { requestVersion, nowIso });

  const offers: Offer[] = [];
  const skipped: Record<string, string> = {};
  for (const m of merchants) {
    if (availability[m.id]?.available === false) continue;
    const q = quote(m, qctx);
    if (q.kind === "offer") offers.push(q.offer);
    else skipped[m.id] = q.reason;
  }

  const ctx: SolveContext = {
    demand,
    offers,
    merchants: merchants.map(toPublic),
    availability,
    nowIso,
    sunkCents,
    ...(previous ? { previous } : {}),
    cancellationTermsFor: termsLookup(merchants),
  };

  const solves: SolveResult[] = [];
  const roundPlans: PlanRound[] = [];
  const transcript: TranscriptEntry[] = [];
  const asked = new Set<string>();
  for (let round = 0; round <= rounds; round++) {
    const res = solve(ctx);
    solves.push(res);
    if (round === rounds) break;
    const plan = planRound(res, demand, round + 1, asked, offers);
    roundPlans.push(plan);
    for (const rq of plan.requests) {
      asked.add(`${rq.offerId}:${rq.lever}`);
      const cur = offers.filter((o) => o.id === rq.offerId).sort((a, b) => b.revision - a.revision)[0];
      const m = merchants.find((x) => x.id === rq.merchantId);
      if (!cur || !m) throw new Error(`Unresolvable request ${rq.offerId}`);
      const out = respond(m, cur, rq.lever, round + 1, qctx);
      if (out.outcome === "revised") {
        cur.status = "superseded";
        offers.push(out.offer);
        transcript.push({ round: round + 1, request: rq, merchantName: m.name, outcome: "revised", reply: out.reply, offer: out.offer });
      } else {
        transcript.push({ round: round + 1, request: rq, merchantName: m.name, outcome: "declined", reply: out.reply });
      }
    }
  }

  return {
    requirements,
    demand,
    qctx,
    merchants,
    availability,
    offers,
    skipped,
    ctx,
    solves,
    roundPlans,
    transcript,
    asked,
    final: solves[solves.length - 1] as SolveResult,
    latest: (merchantId) => latestOffer(offers, merchantId),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Find the evaluated candidate made of exactly these merchants (any order). */
export function candidateOfMerchants(result: SolveResult, merchantIds: string[]): Candidate | undefined {
  const want = [...merchantIds].sort().join("+");
  return result.candidates.find((c) => c.offers.map((o) => o.merchantId).sort().join("+") === want);
}

/** Validate an explicit list of offers against a market's solve context (optionally patched). */
export function validate(market: Pick<Market, "ctx">, offers: Offer[], patch: Partial<SolveContext> = {}): Candidate {
  return validateCandidate({ ...market.ctx, ...patch }, offers);
}

export function merchantNames(c: Candidate): string[] {
  return c.offers.map((o) => o.merchantName);
}
