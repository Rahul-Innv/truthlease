/**
 * View derivations over a Run snapshot. Presentation only: the server owns
 * feasibility, totals and approval. The one place this module re-runs a
 * rule is `closestPackageFor`, which replays the solver's own pure
 * `validateCandidate` against the snapshot to explain a non-selection; its
 * output is labelled as an explanation, never used to decide anything.
 */
import type { CapabilityGroup, Offer, Plan, RejectCode, Run, RunEvent } from "@/lib/contracts";
import { computeExposure } from "@/lib/ledger";
import { deriveDemand, validateCandidate, type SolveContext } from "@/lib/solver";
import { activePlan, GROUPS, offerCovers, PHASE_META, planById } from "./format";

export type NodeState =
  | "candidate"
  | "selected"
  | "replacement"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "awaiting"
  | "no_quote";

export const NODE_STATE_META: Record<NodeState, { label: string; description: string }> = {
  candidate: { label: "Candidate", description: "Open offer; the market has not cleared yet" },
  selected: { label: "Selected", description: "In the current plan" },
  replacement: { label: "Replacement", description: "Added by the repair; needs approval" },
  rejected: { label: "Rejected", description: "Open offer that is not in the chosen package" },
  withdrawn: { label: "Withdrawn", description: "Supplier unavailable or offer withdrawn" },
  superseded: { label: "Superseded", description: "Was in the previous plan; dropped by this one" },
  awaiting: { label: "Awaiting quote", description: "Supplier has not responded yet" },
  no_quote: { label: "No quote", description: "Supplier declined to quote" },
};

export interface MarketNode {
  merchantId: string;
  merchantName: string;
  group: CapabilityGroup;
  /** The revision the node represents (selected revision when selected, else latest). */
  offer: Offer | null;
  revisions: Offer[];
  state: NodeState;
  /** Secondary text tag, e.g. "kept", "replaces Golden Hour Taqueria", "closest · over budget". */
  tag?: string;
  covers: CapabilityGroup[];
  skippedReason?: string;
  /** Part of the cheapest otherwise-valid package when no plan is feasible. */
  closest?: boolean;
  /** Supply assembly tag, e.g. "partial · 120 of 130 meals" or "top-up · 20 meals". */
  assembly?: string;
}

export interface MealCoverage {
  covers: number;
  vegetarian: number;
  /** Meals the request needs (from the offer's partial marker, else the current headcount). */
  of: number | null;
  partial: boolean;
  topup: boolean;
}

/**
 * Meal coverage of one offer revision. Derived from the lines because a later
 * revision (slot move, volume discount) may not repeat the `partial` marker; a
 * revision is a top-up when it or an earlier revision of the same offer id was
 * quoted as one ("Top-up …" provenance note).
 */
export function mealCoverage(run: Run, offer: Offer): MealCoverage | null {
  if (offer.group !== "meals") return null;
  const covers = offer.lines.filter((l) => l.kind === "meal_vegetarian" || l.kind === "meal_standard").reduce((s, l) => s + l.qty, 0);
  const vegetarian = offer.lines.filter((l) => l.kind === "meal_vegetarian").reduce((s, l) => s + l.qty, 0);
  const sameRequest = offer.requestVersion === run.requestVersion && run.requirements;
  const of = offer.partial?.ofMeals ?? (sameRequest ? run.requirements!.headcount : null);
  const topup = run.offers.some((o) => o.id === offer.id && o.revision <= offer.revision && o.provenance.note.startsWith("Top-up"));
  return { covers, vegetarian, of, partial: of !== null && covers < of, topup };
}

export function assemblyTag(c: MealCoverage | null): string | undefined {
  if (!c) return undefined;
  if (c.topup) return `top-up · ${c.covers} meals`;
  if (c.partial && c.of !== null) return `partial · ${c.covers} of ${c.of} meals`;
  return undefined;
}

function latestOf(offers: Offer[]): Offer | null {
  let best: Offer | null = null;
  for (const o of offers) {
    if (!best || o.requestVersion > best.requestVersion || (o.requestVersion === best.requestVersion && o.revision > best.revision)) best = o;
  }
  return best;
}

function skippedReasonFor(events: RunEvent[], merchantId: string, requestVersion: number): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "supplier.skipped") continue;
    const p = e.payload as { merchantId?: unknown; reason?: unknown; requestVersion?: unknown };
    if (p.merchantId !== merchantId) continue;
    if (typeof p.requestVersion === "number" && p.requestVersion !== requestVersion) continue;
    return typeof p.reason === "string" ? p.reason : e.summary;
  }
  return undefined;
}

export function deriveNodes(run: Run, events: RunEvent[]): MarketNode[] {
  const plan = activePlan(run);
  const previous = plan ? planById(run, plan.basedOnRevision) : null;
  const cheapest = run.phase === "no_feasible_plan" ? run.infeasibility?.cheapestInvalid : undefined;
  const nodes: MarketNode[] = [];
  for (const m of run.merchants) {
    const revisions = run.offers
      .filter((o) => o.merchantId === m.id)
      .sort((a, b) => a.requestVersion - b.requestVersion || a.revision - b.revision);
    const latest = latestOf(revisions);
    const sel = plan?.selections.find((s) => s.merchantId === m.id);
    const selectedOffer = sel ? revisions.find((o) => o.id === sel.offerId && o.revision === sel.offerRevision) ?? latest : null;
    const offer = selectedOffer ?? latest;
    const unavailable = run.availability[m.id]?.available === false;
    const node: MarketNode = {
      merchantId: m.id,
      merchantName: m.name,
      group: m.group,
      offer,
      revisions,
      state: "candidate",
      covers: offer ? offerCovers(offer) : [m.group],
    };
    if (unavailable || latest?.status === "withdrawn") {
      node.state = "withdrawn";
      node.tag = run.availability[m.id]?.reason ?? "offer withdrawn";
    } else if (sel) {
      if (plan?.basedOnRevision && (sel.change === "replaced" || sel.change === "added")) {
        node.state = "replacement";
        const from = sel.replacesMerchantId ? run.merchants.find((x) => x.id === sel.replacesMerchantId)?.name : undefined;
        node.tag = from ? `replaces ${from}` : "added";
      } else {
        node.state = "selected";
        if (plan?.basedOnRevision) node.tag = sel.change === "requoted" ? "re-quoted" : "kept";
      }
    } else if (previous?.selections.some((s) => s.merchantId === m.id)) {
      node.state = "superseded";
      node.tag = `dropped from r${previous.revision}`;
    } else if (!latest) {
      const reason = skippedReasonFor(events, m.id, run.requestVersion);
      const collecting = run.phase === "collecting" || run.phase === "draft" || run.phase === "confirming";
      node.state = reason || !collecting ? "no_quote" : "awaiting";
      if (reason) node.skippedReason = reason;
      else if (run.phase === "draft" || run.phase === "confirming") node.tag = "market not open yet";
    } else if (latest.status === "superseded") {
      node.state = "superseded";
      node.tag = "no open revision";
    } else if (latest.status === "expired") {
      node.state = "rejected";
      node.tag = "expired";
    } else if (plan || run.phase === "no_feasible_plan") {
      node.state = "rejected";
      if (cheapest?.merchants.includes(m.name)) {
        node.tag = "closest package · over budget";
        node.closest = true;
      }
    } else {
      node.state = "candidate";
    }
    if (offer) node.assembly = assemblyTag(mealCoverage(run, offer));
    nodes.push(node);
  }
  const order = (g: CapabilityGroup) => GROUPS.indexOf(g);
  return nodes.sort((a, b) => order(a.group) - order(b.group));
}

// ---------------------------------------------------------------------------
// Approval gating (mirrors server preconditions for the button's disabled reason)
// ---------------------------------------------------------------------------

export interface ApprovalGate {
  enabled: boolean;
  reason: string;
  plan: Plan | null;
}

export function approvalGate(run: Run | null, pending: string | null): ApprovalGate {
  if (!run) return { enabled: false, reason: "Loading the run…", plan: null };
  const plan = run.currentPlanRevision != null ? run.plans.find((p) => p.revision === run.currentPlanRevision) ?? null : null;
  const phase = run.phase;
  const notReady = (reason: string): ApprovalGate => ({ enabled: false, reason, plan });
  if (phase === "draft" || phase === "confirming") return notReady("Confirm the requirements first.");
  if (phase === "collecting" || phase === "negotiating" || phase === "clearing") return notReady("The market is still clearing.");
  if (phase === "disrupted" || phase === "repairing") return notReady("A repair is in progress.");
  if (phase === "approved") return notReady("Placing simulated orders…");
  if (phase === "simulated_confirmed") return notReady(plan ? `Plan r${plan.revision} is approved; simulated orders are confirmed.` : "Already approved.");
  if (phase === "no_feasible_plan") return notReady("No feasible plan to approve.");
  if (!plan) return notReady("No proposed plan.");
  if (plan.status !== "proposed") return notReady(`Plan r${plan.revision} is ${plan.status}.`);
  if (plan.requestVersion !== run.requestVersion) return notReady("The request changed after this plan was built.");
  if (!plan.fullyPriced) return notReady("The plan is not fully priced.");
  if (run.job) return notReady("A pipeline job is still running.");
  if (pending) return notReady("Waiting for the server…");
  return { enabled: true, reason: phase === "needs_approval" ? "Repaired plan: changed orders are re-placed on approval." : "Places simulated orders. No real money moves.", plan };
}

export function isBusy(run: Run | null): boolean {
  if (!run) return true;
  return PHASE_META[run.phase].busy || run.job !== null;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface Metrics {
  candidatesChecked: number | null;
  feasibleCandidates: number | null;
  solverMs: number | null;
  /** null for a fresh plan (nothing to change from). */
  changedSelections: number | null;
}

export function metricsFor(run: Run): Metrics {
  const plan = activePlan(run);
  if (run.phase === "no_feasible_plan" && run.infeasibility) {
    return {
      candidatesChecked: run.infeasibility.evaluation.candidatesChecked,
      feasibleCandidates: 0,
      solverMs: run.infeasibility.evaluation.solverMs,
      changedSelections: null,
    };
  }
  if (plan) {
    const changed = plan.basedOnRevision
      ? plan.selections.filter((s) => s.change !== "kept").length + plan.changeSummary.removed.length
      : null;
    return {
      candidatesChecked: plan.evaluation.candidatesChecked,
      feasibleCandidates: plan.evaluation.feasibleCandidates,
      solverMs: plan.evaluation.solverMs,
      changedSelections: changed,
    };
  }
  return { candidatesChecked: null, feasibleCandidates: null, solverMs: null, changedSelections: null };
}

// ---------------------------------------------------------------------------
// Why is this offer not in the package?
// ---------------------------------------------------------------------------

export interface PackageExplanation {
  offers: Offer[];
  rejects: RejectCode[];
  totalCents: number;
  exposureCents: number;
  budgetCents: number;
  candidatesTried: number;
}

function latestOpen(offers: Offer[]): Offer[] {
  const byId = new Map<string, Offer>();
  for (const o of offers) {
    const cur = byId.get(o.id);
    if (!cur || o.revision > cur.revision) byId.set(o.id, o);
  }
  return [...byId.values()].filter((o) => o.status === "open");
}

/**
 * Re-checks every ≤3-offer package that contains `offer` (one offer per
 * supplier) with the solver's own validator against this snapshot, and
 * returns the one with the fewest failing rules (then lowest total).
 * Returns null when the offer is not open or requirements are absent.
 */
export function closestPackageFor(run: Run, offer: Offer): PackageExplanation | null {
  if (!run.requirements || offer.status !== "open") return null;
  const plan = activePlan(run);
  const previous = plan ? planById(run, plan.basedOnRevision) : null;
  const exposure = computeExposure(run.orders, run.ledger);
  const termsById = new Map(run.merchants.map((m) => [m.id, m.cancellation]));
  const ctx: SolveContext = {
    demand: deriveDemand(run.requirements),
    offers: run.offers,
    merchants: run.merchants,
    availability: run.availability,
    nowIso: plan?.createdAt ?? run.updatedAt,
    sunkCents: exposure.retainedCents + exposure.pendingRefundCents,
    ...(previous
      ? { previous: { selections: previous.selections, activeOrders: run.orders.filter((o) => o.status === "simulated_placed" || o.status === "simulated_confirmed") } }
      : {}),
    cancellationTermsFor: (id) => termsById.get(id),
  };
  const others = latestOpen(run.offers).filter((o) => o.merchantId !== offer.merchantId);
  const sets: Offer[][] = [[offer]];
  for (let i = 0; i < others.length; i++) {
    const a = others[i]!;
    sets.push([offer, a]);
    for (let j = i + 1; j < others.length; j++) {
      const b = others[j]!;
      if (b.merchantId === a.merchantId) continue;
      sets.push([offer, a, b]);
    }
  }
  let best: PackageExplanation | null = null;
  for (const set of sets) {
    const c = validateCandidate(ctx, set);
    const cand: PackageExplanation = {
      offers: set,
      rejects: c.rejects,
      totalCents: c.totalCents,
      exposureCents: c.exposureCents,
      budgetCents: ctx.demand.budgetCents,
      candidatesTried: sets.length,
    };
    if (!best || cand.rejects.length < best.rejects.length || (cand.rejects.length === best.rejects.length && cand.totalCents < best.totalCents)) best = cand;
  }
  return best;
}
