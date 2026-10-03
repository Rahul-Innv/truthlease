/**
 * Service layer: commands, phase machine, idempotency, optimistic versioning
 * and the resumable pipeline (collect → negotiate → clear, and repair).
 *
 * Every state change is one CAS commit of the whole run plus its events.
 * Pipeline work is split into small units (one supplier quote, one buyer
 * round plan, one seller reply, one clearing pass) so `advance()` can be
 * called repeatedly and resumes from stored state after a restart. Pipeline
 * events carry `causeId = job.id`; the job's own events are its journal.
 *
 * Seller policy is read only from the private catalog passed in `deps`
 * (default: CATALOG). The run stores the public profile only.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ATTENDEE_TOKEN_RE,
  AttendeeApplyCommand,
  AttendeeLinkCommand,
  MAX_ATTENDEE_RESPONSES,
  attendeePublicView,
  newAttendeeToken,
  summarizeAttendees,
  tokensEqual,
  type AttendeePublicView,
} from "./attendee";
import { MAX_REQUESTS_PER_ROUND, MAX_ROUNDS, planRound, type CounterRequest } from "./buyer";
import { CATALOG, toPublic } from "./catalog";
import {
  ApproveCommand,
  AttendeeSubmitCommand,
  Cents,
  DisruptCommand,
  IdempotencyKey,
  Id,
  Infeasibility,
  ItemKind,
  LocalTime,
  NegotiationLever,
  Qty,
  RejectCode,
  RequestInput,
  Requirements,
  Run,
  SettleRefundCommand,
  UpdateBudgetCommand,
  type Disruption,
  type EventType,
  type LedgerEntry,
  type Merchant,
  type Offer,
  type Phase,
  type Plan,
  type RequirementField,
  type RunEvent,
  type SimOrder,
} from "./contracts";
import { DEFAULT_NOW_LOCAL, DEFAULT_TIMEZONE, PRESET_TEXT } from "./fixtures";
import { buildRequirements } from "./interpret";
import { cancellationExposure, computeExposure, isActiveOrder } from "./ledger";
import { formatCents } from "./money";
import type { ProviderResult, ReasoningProvider } from "./providers/types";
import { delayOffer, quote, respond } from "./seller";
import {
  buildPlan,
  deriveDemand,
  explainInfeasibility,
  solve,
  validateCandidate,
  type Candidate,
  type PreviousState,
  type SolveContext,
  type SolveResult,
} from "./solver";
import { IdempotencyReplay, NotFound, ServiceError, VersionConflict, type NewEvent, type Store, type StoredResponse } from "./store";
import { formatLocal, fromMinutes, nextDemoEventDate } from "./time";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export { NotFound, ServiceError, VersionConflict };

/** The command is not allowed in the run's current phase or state (409). */
export class PhaseError extends ServiceError {
  constructor(message: string, details?: unknown, code = "phase_conflict") {
    super(409, code, message, details);
  }
}

/** The command body or edited values are invalid (400). */
export class ValidationError extends ServiceError {
  constructor(message: string, details?: unknown, code = "validation_error") {
    super(400, code, message, details);
  }
}

/** A pipeline step belongs to a job that is no longer the active job for the current request. */
export class StaleJob extends ServiceError {
  constructor(message: string, details?: unknown) {
    super(409, "stale_job", message, details);
  }
}

/** Approval revalidation failed on the exact selected offer revisions (409). */
export class ApprovalRejected extends ServiceError {
  constructor(
    readonly rejects: RejectCode[],
    message: string,
  ) {
    super(409, "approval_rejected", message, { rejects });
  }
}

// ---------------------------------------------------------------------------
// Command schemas not covered by contracts (built from contract primitives)
// ---------------------------------------------------------------------------

export const ConfirmEdits = z
  .object({
    headcount: Qty.min(1),
    vegetarianMin: Qty,
    readyByLocal: LocalTime,
    budgetCents: Cents,
    items: z.object({ drinks: z.boolean(), plates: z.boolean(), utensils: z.boolean() }).partial(),
  })
  .partial()
  .strict();
export const ConfirmCommand = z.object({ edits: ConfirmEdits.optional(), idempotencyKey: IdempotencyKey.optional() });
export type ConfirmCommand = z.infer<typeof ConfirmCommand>;

export const SubmitRequestCommand = RequestInput.extend({ idempotencyKey: IdempotencyKey.optional() });
export type SubmitRequestCommand = z.infer<typeof SubmitRequestCommand>;

export type SettleRefundCommand = z.infer<typeof SettleRefundCommand>;
export type UpdateBudgetCommand = z.infer<typeof UpdateBudgetCommand>;

/** Payload of a `negotiation.requested` journal event. */
const PlannedAsk = z.object({
  round: z.number().int().min(1).max(2),
  index: z.number().int().min(0),
  messageId: Id,
  offerId: Id,
  merchantId: Id,
  lever: NegotiationLever,
  ask: z.string().max(200),
  topup: z.object({ vegetarian: z.number().int().min(0).max(5000), standard: z.number().int().min(0).max(5000) }).optional(),
});
type PlannedAsk = z.infer<typeof PlannedAsk>;

/** Parse with a contract schema; failures become a 400 ValidationError. */
export function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ValidationError(
      "Request body failed validation.",
      r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ServiceClock {
  now(): string;
}

export interface ServiceDeps {
  store: Store;
  clock: ServiceClock;
  provider: ReasoningProvider;
  /** Readability pacing between supplier events in the background runner. 0 in tests. */
  paceMs: number;
  /** Private catalog (with seller policy). Defaults to the fictional demo CATALOG. */
  catalog?: Merchant[];
  /** Called after a command leaves a job to run. The app wires the background runner; tests call drain(). */
  scheduleJob?: (runId: string) => void;
}

export interface AdvanceResult {
  run: Run;
  /** True when the run has no job left. */
  done: boolean;
  /** True when the unit was a supplier event (the runner sleeps paceMs after it). */
  paced: boolean;
  step: string;
}

export interface Service {
  readonly paceMs: number;
  readonly reasoning: ReasoningProvider["mode"];
  getRun(runId: string): Run | null;
  currentRunId(): string | null;
  listEvents(runId: string, afterSeq?: number, limit?: number): RunEvent[];
  createPresetRun(): Promise<Run>;
  getOrCreateCurrent(): Promise<Run>;
  submitRequest(runId: string, cmd: SubmitRequestCommand): Promise<Run>;
  confirmRequirements(runId: string, cmd?: ConfirmCommand): Promise<Run>;
  advance(runId: string): Promise<AdvanceResult>;
  /** Run the active job to completion (used by tests and by the background runner). */
  drain(runId: string, maxSteps?: number): Promise<Run>;
  approve(runId: string, cmd: ApproveCommand): Promise<Run>;
  disrupt(runId: string, cmd: DisruptCommand): Promise<Run>;
  settleRefund(runId: string, cmd: SettleRefundCommand): Promise<Run>;
  updateBudget(runId: string, cmd: UpdateBudgetCommand): Promise<Run>;
  reset(): Promise<Run>;
  /** Record job.failed for the active job (runner error path). */
  failJob(runId: string, jobId: string | undefined, reason: string): Run | null;
  /** P1 organizer: create the run's public, submit-only attendee link (one active link per run). */
  createAttendeeLink(runId: string, cmd?: AttendeeLinkCommand): Promise<Run>;
  /** P1 public: record or update one anonymous answer by link token; returns the public view only. */
  submitAttendee(cmd: AttendeeSubmitCommand): Promise<AttendeePublicView>;
  /** P1 public: the event summary behind a link token (no budget, plan, offers or run id). */
  getAttendeeView(token: string): AttendeePublicView;
  /** P1 organizer: apply aggregated counts to the requirements; an existing plan is re-quoted and repaired. */
  applyAttendeeCounts(runId: string, cmd: AttendeeApplyCommand): Promise<Run>;
}

export type AttendeeSubmitCommand = z.infer<typeof AttendeeSubmitCommand>;

const BUSY_PHASES: readonly Phase[] = ["collecting", "negotiating", "clearing", "disrupted", "repairing", "approved"];
const DISRUPTABLE_PHASES: readonly Phase[] = ["simulated_confirmed", "proposed", "needs_approval", "no_feasible_plan"];
const REEVALUATE_PHASES: readonly Phase[] = ["proposed", "no_feasible_plan", "needs_approval", "simulated_confirmed"];

type Job = NonNullable<Run["job"]>;
interface Step {
  run: Run;
  events: NewEvent[];
  paced: boolean;
  label: string;
}

// ---------------------------------------------------------------------------
// Pure helpers over a Run
// ---------------------------------------------------------------------------

const clone = <T>(x: T): T => structuredClone(x);
const keyOf = (id: string, revision: number) => `${id}@${revision}`;
const short = (s: string) => s.slice(0, 200);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ev(type: EventType, summary: string, payload: Record<string, unknown>, at: string, causeId?: string): NewEvent {
  return { type, summary: short(summary), payload, at, ...(causeId ? { causeId } : {}) };
}

function isBusy(run: Run): boolean {
  return run.job !== null || BUSY_PHASES.includes(run.phase);
}

function requireRequirements(run: Run): Requirements {
  if (!run.requirements) throw new PhaseError("Requirements have not been extracted yet; submit a request first.", { phase: run.phase });
  return run.requirements;
}

function latestRevisionOf(offers: Offer[], offerId: string): Offer | undefined {
  let best: Offer | undefined;
  for (const o of offers) if (o.id === offerId && (!best || o.revision > best.revision)) best = o;
  return best;
}

function latestOpenOffers(offers: Offer[]): Offer[] {
  const byId = new Map<string, Offer>();
  for (const o of offers) {
    const cur = byId.get(o.id);
    if (!cur || o.revision > cur.revision) byId.set(o.id, o);
  }
  return [...byId.values()].filter((o) => o.status === "open");
}

function openGroups(run: Run): { meals: boolean; drinks: boolean; delivery: boolean } {
  const live = latestOpenOffers(run.offers).filter((o) => run.availability[o.merchantId]?.available !== false);
  return {
    meals: live.some((o) => o.group === "meals"),
    drinks: live.some((o) => o.group === "drinks_consumables"),
    delivery: live.some((o) => o.group === "delivery"),
  };
}

function latestApproved(run: Run): Plan | undefined {
  return [...run.plans].reverse().find((p) => p.status === "approved");
}

/** The plan a repair preserves: the current approved/proposed plan, else the latest approved one. */
function basisPlan(run: Run): Plan | undefined {
  const cur = run.currentPlanRevision !== null ? run.plans.find((p) => p.revision === run.currentPlanRevision) : undefined;
  if (cur && (cur.status === "approved" || cur.status === "proposed")) return cur;
  return latestApproved(run) ?? cur;
}

/** Repair ranking applies once something was approved (orders exist or existed). */
function hasCommitments(run: Run): boolean {
  return run.plans.some((p) => p.status === "approved") || run.orders.some(isActiveOrder);
}

function previousState(run: Run): PreviousState | undefined {
  const basis = basisPlan(run);
  const activeOrders = run.orders.filter(isActiveOrder);
  if (!basis && activeOrders.length === 0) return undefined;
  return { selections: basis?.selections ?? [], activeOrders };
}

function supersedeProposed(run: Run): void {
  for (const p of run.plans) if (p.status === "proposed") p.status = "superseded";
}

function fullRejects(r: Partial<Record<RejectCode, number>>): Record<RejectCode, number> {
  return Object.fromEntries(RejectCode.options.map((c) => [c, r[c] ?? 0])) as Record<RejectCode, number>;
}

function fullCoverage(c: Partial<Record<ItemKind, number>>): Record<ItemKind, number> {
  return Object.fromEntries(ItemKind.options.map((k) => [k, c[k] ?? 0])) as Record<ItemKind, number>;
}

/**
 * Zod 4 records keyed by an enum are exhaustive. The solver emits partial
 * reject counts and per-selection coverage, so zero-fill them before storing.
 */
function normalizePlan(p: Plan): Plan {
  return {
    ...p,
    selections: p.selections.map((s) => ({ ...s, coverage: fullCoverage(s.coverage) })),
    evaluation: { ...p.evaluation, rejectedByReason: fullRejects(p.evaluation.rejectedByReason) },
    changeSummary: { ...p.changeSummary, ...(p.changeSummary.widened ? { widened: short(p.changeSummary.widened) } : {}) },
    reason: short(p.reason),
  };
}

function normalizeInfeasibility(i: Infeasibility): Infeasibility {
  return Infeasibility.parse({
    ...i,
    summary: short(i.summary),
    details: i.details.slice(0, 12).map(short),
    evaluation: { ...i.evaluation, rejectedByReason: fullRejects(i.evaluation.rejectedByReason) },
  });
}

function fulfillmentLabel(o: Offer): string {
  const t = formatLocal(o.fulfillment.timeLocal);
  if (o.fulfillment.mode === "pickup_only") return `ready ${t} for pickup`;
  if (o.fulfillment.mode === "courier") {
    return `arrives ${t}${o.fulfillment.pickupByLocal ? `, pickups by ${formatLocal(o.fulfillment.pickupByLocal)}` : ""}`;
  }
  return `arrives ${t}`;
}

function leverLabel(l: NegotiationLever): string {
  return l === "volume_discount" ? "volume pricing" : l === "earlier_slot" ? "an earlier slot" : l === "later_pickup" ? "a later pickup window" : "a top-up quantity";
}

function summarizeRequirements(r: Requirements): string {
  const missing = r.missing.length ? ` · missing: ${r.missing.join(", ")}` : "";
  return `${r.headcount} attendees, ≥${r.vegetarianMin} vegetarian, ready by ${formatLocal(r.readyByLocal)}, budget ${formatCents(r.budgetCents)}${missing}`;
}

function modelEvents<T>(component: string, res: ProviderResult<T>, at: string, causeId?: string): NewEvent[] {
  const out: NewEvent[] = [];
  if (res.callsUsed > 0) {
    out.push(ev("model.call", `${component}: ${res.callsUsed} model call(s)`, { component, calls: res.callsUsed, reasoning: res.reasoning }, at, causeId));
  }
  if (res.fallback) {
    out.push(ev("model.fallback", `${component} fell back to local rules: ${res.fallback.reason}`, { component, reason: res.fallback.reason }, at, causeId));
  }
  return out;
}

/** Append an offer revision, keeping (id, revision) unique and at most one open revision per id. */
function pushOffer(run: Run, offer: Offer): Offer {
  const prior = run.offers.filter((o) => o.id === offer.id);
  const maxRev = prior.reduce((m, o) => Math.max(m, o.revision), 0);
  const next = offer.revision > maxRev ? offer : { ...offer, revision: maxRev + 1, supersedesRevision: maxRev };
  for (const o of prior) if (o.status === "open") o.status = "superseded";
  run.offers.push(next);
  return next;
}

function addLedger(run: Run, kind: LedgerEntry["kind"], orderId: string, cents: number, at: string): void {
  run.ledger.push({ id: `led_${run.ledger.length + 1}`, kind, orderId, cents, at, simulated: true });
}

function newJob(run: Run, kind: Job["kind"], now: string): Job {
  // The committing write produces version + 1, which is unique per run.
  return { id: `job_${run.version + 1}`, kind, requestVersion: run.requestVersion, startedAt: now };
}

/** Close an active order under the merchant's cancellation terms, writing ledger rows. */
const CARRY_FORWARD_TERMS = { refundablePct: 100, settlement: "immediate" as const, note: "Same-supplier revision: the previous simulated charge is released in full; no cancellation terms apply." };

function closeOrder(run: Run, order: SimOrder, status: "cancelled" | "superseded", reason: string, now: string, causeId?: string, termsOverride?: typeof CARRY_FORWARD_TERMS): NewEvent[] {
  const terms = termsOverride ?? run.merchants.find((m) => m.id === order.merchantId)?.cancellation ?? { refundablePct: 0, settlement: "immediate" as const, note: "No terms on file; treated as nonrefundable." };
  const c = cancellationExposure(order.amountCents, terms);
  order.status = status;
  order.cancellation = { reason: short(reason), retainedCents: c.retainedCents, refundCents: c.refundCents, refundStatus: c.refundStatus, cancelledAt: now };
  const verb = status === "superseded" ? "superseded" : "cancelled";
  const events: NewEvent[] = [
    ev(
      "order.cancelled",
      `${order.merchantName} order ${verb} (simulated): ${formatCents(c.refundCents)} refund ${c.refundStatus}, ${formatCents(c.retainedCents)} retained`,
      { orderId: order.id, merchantId: order.merchantId, status, reason, retainedCents: c.retainedCents, refundCents: c.refundCents, refundStatus: c.refundStatus, terms: terms.note, simulated: true },
      now,
      causeId,
    ),
  ];
  if (c.retainedCents > 0) addLedger(run, "retained", order.id, c.retainedCents, now);
  if (c.refundStatus === "pending") {
    addLedger(run, "refund_pending", order.id, c.refundCents, now);
    events.push(ev("refund.pending", `Simulated refund of ${formatCents(c.refundCents)} from ${order.merchantName} is pending; it does not restore budget until settled`, { orderId: order.id, cents: c.refundCents, simulated: true }, now, causeId));
  } else if (c.refundStatus === "settled") {
    addLedger(run, "refund_settled", order.id, c.refundCents, now);
    events.push(ev("refund.settled", `Simulated refund of ${formatCents(c.refundCents)} from ${order.merchantName} settled`, { orderId: order.id, cents: c.refundCents, simulated: true }, now, causeId));
  }
  return events;
}

function applyEdits(req: Requirements, edits: z.infer<typeof ConfirmEdits>): Requirements {
  const r = clone(req);
  const touched: RequirementField[] = [];
  if (edits.headcount !== undefined) {
    r.headcount = edits.headcount;
    touched.push("headcount");
  }
  if (edits.vegetarianMin !== undefined) {
    r.vegetarianMin = edits.vegetarianMin;
    touched.push("vegetarianMin");
  }
  if (edits.readyByLocal !== undefined) {
    r.readyByLocal = edits.readyByLocal;
    touched.push("readyBy");
  }
  if (edits.budgetCents !== undefined) {
    r.budgetCents = edits.budgetCents;
    touched.push("budget");
  }
  for (const k of ["drinks", "plates", "utensils"] as const) {
    const v = edits.items?.[k];
    if (v !== undefined) {
      r.items[k] = v;
      touched.push(k);
    }
  }
  if (r.vegetarianMin > r.headcount) {
    throw new ValidationError("Vegetarian minimum cannot exceed headcount.", { headcount: r.headcount, vegetarianMin: r.vegetarianMin });
  }
  for (const f of touched) r.fieldStatus[f] = "confirmed";
  r.missing = r.missing.filter((f) => !touched.includes(f));
  r.assumptions = r.assumptions.filter((a) => !touched.includes(a.field) || a.field === "readyBy");
  const parsed = Requirements.safeParse(r);
  if (!parsed.success) throw new ValidationError("Edited requirements are invalid.", parsed.error.issues.map((i) => i.message));
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createService(deps: ServiceDeps): Service {
  const { store, clock, provider } = deps;
  const catalog = deps.catalog ?? CATALOG;
  const publicCatalog = catalog.map(toPublic);
  const merchantById = new Map(catalog.map((m) => [m.id, m]));
  /** In-flight provider calls per run, aborted when the request moves or the demo resets. */
  const inflight = new Map<string, AbortController>();
  let creating: Promise<Run> | null = null;

  function load(runId: string): Run {
    const run = store.getRun(runId);
    if (!run) throw new NotFound(`Run ${runId} not found.`);
    return run;
  }

  function runFromResponse(r: StoredResponse): Run {
    return Run.parse((r.body as { run?: unknown }).run);
  }

  function checkFingerprint(stored: StoredResponse, fingerprint: string | undefined): void {
    const seen = (stored.body as { fingerprint?: string }).fingerprint;
    if (fingerprint && seen && seen !== fingerprint) {
      throw new ValidationError("Idempotency key reused with a different request body.", { code: "idempotency_mismatch" });
    }
  }

  function replay(runId: string, scope: string, key: string | undefined, fingerprint?: string): Run | null {
    if (!key) return null;
    const stored = store.getIdempotent(runId, `${scope}:${key}`);
    if (!stored) return null;
    checkFingerprint(stored, fingerprint);
    return runFromResponse(stored);
  }

  /** Stable hash of a command body (minus its key) so a reused key with a different body is rejected. */
  function fingerprintOf(raw: unknown): string {
    const canon = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "idempotencyKey").sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
    return createHash("sha256").update(JSON.stringify(canon(raw))).digest("hex").slice(0, 32);
  }

  function schedule(run: Run): void {
    if (run.job && deps.scheduleJob) deps.scheduleJob(run.id);
  }

  function abortInflight(runId?: string): void {
    for (const [id, c] of inflight) {
      if (runId === undefined || id === runId) {
        c.abort();
        inflight.delete(id);
      }
    }
  }

  /** Read → compute → CAS commit (+ idempotent response). Retries once on VersionConflict. */
  function mutate(runId: string, scope: string, key: string | undefined, fingerprint: string | undefined, fn: (run: Run, now: string) => { run: Run; events: NewEvent[] }): Run {
    for (let attempt = 0; ; attempt++) {
      const cached = replay(runId, scope, key, fingerprint);
      if (cached) return cached;
      const current = load(runId);
      const now = clock.now();
      const out = fn(clone(current), now);
      out.run.updatedAt = now;
      try {
        return store.commit({
          run: out.run,
          expectedVersion: current.version,
          events: out.events,
          ...(key ? { idempotent: { key: `${scope}:${key}`, body: (r: Run) => ({ run: r, ...(fingerprint ? { fingerprint } : {}) }) } } : {}),
        });
      } catch (err) {
        if (err instanceof IdempotencyReplay) {
          checkFingerprint(err.response, fingerprint);
          return runFromResponse(err.response);
        }
        if (err instanceof VersionConflict && attempt === 0) continue;
        throw err;
      }
    }
  }

  function solveContext(run: Run, nowIso: string, previous?: PreviousState): SolveContext {
    const req = requireRequirements(run);
    const ex = computeExposure(run.orders, run.ledger);
    return {
      demand: deriveDemand(req),
      offers: run.offers,
      merchants: run.merchants,
      availability: run.availability,
      nowIso,
      sunkCents: ex.retainedCents + ex.pendingRefundCents,
      ...(previous ? { previous } : {}),
      cancellationTermsFor: (id) => run.merchants.find((m) => m.id === id)?.cancellation,
    };
  }

  function makePlan(run: Run, ctx: SolveContext, result: SolveResult, candidate: Candidate, now: string, basedOn?: number, widened?: string): Plan {
    const req = requireRequirements(run);
    const ex = computeExposure(run.orders, run.ledger);
    const plan = buildPlan({
      ctx,
      result,
      candidate,
      revision: run.plans.reduce((m, p) => Math.max(m, p.revision), 0) + 1,
      ...(basedOn ? { basedOnRevision: basedOn } : {}),
      requestVersion: run.requestVersion,
      createdAt: now,
      readyByLocal: req.readyByLocal,
      latestArrivalLocal: fromMinutes(ctx.demand.latestArrivalMin),
      budgetCents: req.budgetCents,
      sunk: { retainedCents: ex.retainedCents, pendingRefundCents: ex.pendingRefundCents },
      ...(widened ? { widened } : {}),
    });
    return normalizePlan(plan);
  }

  function pushPlan(run: Run, plan: Plan): void {
    supersedeProposed(run);
    run.plans.push(plan);
    run.currentPlanRevision = plan.revision;
    run.infeasibility = null;
  }

  function evaluatedEvent(result: SolveResult, mode: "fresh" | "repair", now: string, causeId: string): NewEvent {
    return ev(
      "clearing.evaluated",
      `Evaluated ${result.candidatesChecked} candidate combinations: ${result.feasibleCandidates} feasible (${result.solverMs} ms solver time)`,
      {
        mode,
        candidatesChecked: result.candidatesChecked,
        feasibleCandidates: result.feasibleCandidates,
        rejectedByReason: fullRejects(result.rejectedByReason),
        solverMs: result.solverMs,
        scope: "optimal among evaluated candidates only",
      },
      now,
      causeId,
    );
  }

  function setInfeasible(run: Run, ctx: SolveContext, result: SolveResult, now: string, causeId: string): NewEvent {
    const inf = normalizeInfeasibility(explainInfeasibility(ctx, result, openGroups(run)));
    run.infeasibility = inf;
    run.phase = "no_feasible_plan";
    // A proposal that was never approved is no longer valid against the new evaluation.
    supersedeProposed(run);
    const gap = inf.cheapestInvalid ? ` · gap ${formatCents(inf.cheapestInvalid.budgetGapCents)}` : "";
    return ev("plan.infeasible", `NO FEASIBLE PLAN (${inf.kind})${gap}: ${inf.summary}`, { infeasibility: inf }, now, causeId);
  }

  /** Explain why an unaffected previous selection was dropped by the repair. */
  function explainWidened(run: Run, ctx: SolveContext, best: Candidate, previous: PreviousState): string | undefined {
    const bestKeys = new Set(best.offers.map((o) => keyOf(o.id, o.revision)));
    const prevMerchants = new Set(previous.selections.map((s) => s.merchantId));
    const notes: string[] = [];
    for (const s of previous.selections) {
      if (bestKeys.has(keyOf(s.offerId, s.offerRevision))) continue;
      if (best.offers.some((o) => o.merchantId === s.merchantId)) continue; // re-quoted, not dropped
      const offer = run.offers.find((o) => o.id === s.offerId && o.revision === s.offerRevision);
      const unaffected =
        offer !== undefined &&
        offer.status === "open" &&
        latestRevisionOf(run.offers, s.offerId)?.revision === s.offerRevision &&
        run.availability[s.merchantId]?.available !== false &&
        Date.parse(offer.expiresAt) > Date.parse(ctx.nowIso);
      if (!unaffected || !offer) continue;
      const replacement = best.offers.find((o) => o.group === s.group && !prevMerchants.has(o.merchantId));
      const alt = replacement ? best.offers.map((o) => (o === replacement ? offer : o)) : [...best.offers, offer];
      const c = validateCandidate(ctx, alt);
      const who = replacement ? `; ${replacement.merchantName} replaces it` : "";
      if (!c.feasible && c.rejects.every((r) => r === "over_budget")) {
        notes.push(`Keeping ${s.merchantName} would exceed the budget by ${formatCents(c.exposureCents - ctx.demand.budgetCents)}${who}.`);
      } else if (!c.feasible) {
        notes.push(`Keeping ${s.merchantName} fails ${c.rejects.join(", ")}${who}.`);
      } else {
        notes.push(`${s.merchantName} was dropped because a combination with fewer changes or lower exposure exists${who}.`);
      }
    }
    return notes.length ? short(notes.join(" ")) : undefined;
  }

  /** Re-run clearing (fresh) or repair (when commitments exist) with the existing open offers. */
  function startReevaluation(run: Run, now: string, events: NewEvent[], cause: string): void {
    if (hasCommitments(run)) {
      run.job = newJob(run, "repair", now);
      run.phase = "repairing";
      events.push(ev("repair.started", `Re-evaluating the plan with existing offers (${cause.replace(/_/g, " ")})`, { cause, jobId: run.job.id }, now, run.job.id));
    } else {
      run.job = newJob(run, "collect", now);
      run.phase = "clearing";
    }
    run.infeasibility = null;
  }

  /**
   * Quantities changed (a headcount_changed disruption, or attendee counts applied to a plan):
   * bump the request version, store the new requirements, and re-quote every demand-dependent
   * offer (meals, drinks) at the new quantities. Suppliers that can no longer quote withdraw.
   * Courier offers are untouched.
   */
  function requoteForRequirements(run: Run, nextReq: Requirements, now: string, causeId: string): NewEvent[] {
    run.requestVersion += 1;
    run.requirements = Requirements.parse(nextReq);
    const headcount = run.requirements.headcount;
    const demand = deriveDemand(run.requirements);
    const effects: NewEvent[] = [];
    // Quantities are part of meals and drinks offers: re-quote them. Courier offers are untouched.
    for (const m of catalog) {
      if (m.group === "delivery" || run.availability[m.id]?.available === false) continue;
      const prior = run.offers.filter((o) => o.merchantId === m.id && o.status === "open");
      const q = quote(m, { demand, requestVersion: run.requestVersion, nowIso: now, reasoning: "local" });
      if (q.kind === "offer") {
        for (const p of prior) p.status = "superseded";
        const offer = pushOffer(run, q.offer);
        effects.push(ev("offer.requoted", `${m.name} re-quoted for ${headcount}: ${formatCents(offer.totalCents)}, ${fulfillmentLabel(offer)}`, { reason: "headcount_changed", merchantId: m.id, supersedes: prior.map((p) => ({ offerId: p.id, revision: p.revision })), offer }, now, causeId));
      } else {
        for (const p of prior) {
          p.status = "withdrawn";
          effects.push(ev("offer.withdrawn", `${m.name} withdrew ${p.id} r${p.revision}: ${q.reason}`, { offerId: p.id, revision: p.revision, merchantId: m.id, reason: q.reason }, now, causeId));
        }
        effects.push(ev("supplier.skipped", `${m.name} cannot quote for ${headcount}: ${q.reason}`, { merchantId: m.id, merchantName: m.name, reason: q.reason }, now, causeId));
      }
    }
    return effects;
  }

  // -------------------------------------------------------------------------
  // Pipeline units
  // -------------------------------------------------------------------------

  async function computeStep(run: Run, job: Job, now: string, signal: AbortSignal): Promise<Step> {
    switch (run.phase) {
      case "collecting":
        return collectStep(run, job, now, signal);
      case "negotiating":
        return negotiateStep(run, job, now, signal);
      case "clearing":
        return clearStep(run, job, now);
      case "disrupted":
        return startRepairStep(run, job, now);
      case "repairing":
        return repairStep(run, job, now);
      default:
        throw new Error(`Job ${job.id} (${job.kind}) cannot run in phase "${run.phase}".`);
    }
  }

  function afterNegotiation(job: Job): Phase {
    return job.kind === "collect" ? "clearing" : "repairing";
  }

  /** One supplier enters and quotes (round 0). */
  async function collectStep(run: Run, job: Job, now: string, signal: AbortSignal): Promise<Step> {
    const entered = new Set(
      store
        .listEventsByCause(run.id, job.id)
        .filter((e) => e.type === "supplier.entered")
        .map((e) => String(e.payload.merchantId)),
    );
    const pending = catalog.filter((m) => run.availability[m.id]?.available !== false && !entered.has(m.id));
    const m = pending[0];
    if (!m) {
      run.phase = "negotiating";
      return negotiateStep(run, job, now, signal);
    }
    const demand = deriveDemand(requireRequirements(run));
    const q = quote(m, { demand, requestVersion: run.requestVersion, nowIso: now, reasoning: "local" });
    const events: NewEvent[] = [ev("supplier.entered", `${m.name} entered the market`, { merchantId: m.id, merchantName: m.name, group: m.group }, now, job.id)];
    if (q.kind === "offer") {
      const offer = pushOffer(run, q.offer);
      events.push(ev("offer.received", `${m.name} quoted ${formatCents(offer.totalCents)}, ${fulfillmentLabel(offer)}`, { offer }, now, job.id));
    } else {
      events.push(ev("supplier.skipped", `${m.name} declined to quote: ${q.reason}`, { merchantId: m.id, merchantName: m.name, reason: q.reason }, now, job.id));
    }
    if (pending.length === 1) run.phase = "negotiating";
    return { run, events, paced: true, label: `collect:${m.id}` };
  }

  /** Either answer the next planned ask of the current round, or plan the next round. */
  async function negotiateStep(run: Run, job: Job, now: string, signal: AbortSignal): Promise<Step> {
    const planned: PlannedAsk[] = [];
    for (const e of store.listEventsByCause(run.id, job.id)) {
      if (e.type !== "negotiation.requested") continue;
      const p = PlannedAsk.safeParse(e.payload);
      if (p.success) planned.push(p.data);
    }
    const answered = new Set(run.negotiation.map((n) => n.id));
    const round = planned.reduce((r, a) => Math.max(r, a.round), 0);
    const open = planned.filter((a) => a.round === round && !answered.has(a.messageId)).sort((a, b) => a.index - b.index);
    const nextAsk = open[0];
    if (nextAsk) return answerStep(run, job, nextAsk, open.length === 1, now, signal);

    if (round >= MAX_ROUNDS) {
      run.phase = afterNegotiation(job);
      return computeStep(run, job, now, signal);
    }

    const r = round + 1;
    const previous = job.kind === "repair" || run.orders.some(isActiveOrder) ? previousState(run) : undefined;
    const ctx = solveContext(run, now, previous);
    const result = solve(ctx);
    const asked = new Set([...run.negotiation.map((n) => `${n.offerId}:${n.lever}`), ...planned.map((a) => `${a.offerId}:${a.lever}`)]);
    const pr = planRound(result, ctx.demand, r, asked, run.offers);
    const choice = await provider.chooseAsks(pr.requests, { round: r }, signal);
    run.modelCalls += choice.callsUsed;
    const events = modelEvents("buyer", choice, now, job.id);
    // The provider may reorder or trim the code-derived asks; it can never invent one.
    const allowed = new Map(pr.requests.map((q) => [`${q.offerId}:${q.lever}`, q]));
    const asks: CounterRequest[] = [];
    for (const c of choice.value) {
      const base = allowed.get(`${c.offerId}:${c.lever}`);
      if (!base || asks.some((a) => a.offerId === base.offerId && a.lever === base.lever)) continue;
      asks.push({ ...base, ask: short(c.ask || base.ask) });
      if (asks.length >= MAX_REQUESTS_PER_ROUND) break;
    }
    if (asks.length === 0) {
      run.phase = afterNegotiation(job);
      const next = await computeStep(run, job, now, signal);
      return { ...next, events: [...events, ...next.events] };
    }
    asks.forEach((a, index) => {
      const name = merchantById.get(a.merchantId)?.name ?? a.merchantId;
      events.push(
        ev(
          "negotiation.requested",
          `Round ${r}: asked ${name} for ${leverLabel(a.lever)}`,
          { round: r, index, messageId: `neg_${job.id}_${r}_${index}`, offerId: a.offerId, merchantId: a.merchantId, merchantName: name, lever: a.lever, ask: a.ask, ...(a.topup ? { topup: a.topup } : {}), reasoning: choice.reasoning, shortlist: pr.shortlist },
          now,
          job.id,
        ),
      );
    });
    return { run, events, paced: false, label: `negotiate:plan:${r}` };
  }

  /** One seller replies to one ask. */
  async function answerStep(run: Run, job: Job, ask: PlannedAsk, lastInRound: boolean, now: string, signal: AbortSignal): Promise<Step> {
    const events: NewEvent[] = [];
    const cur = latestRevisionOf(run.offers, ask.offerId);
    const m = merchantById.get(ask.merchantId);
    let outcome: "revised" | "declined" = "declined";
    let reply = "Offer is no longer open.";
    let reasoning: Run["reasoning"] = "local";
    let revised: Offer | undefined;
    let leverUsed = ask.lever;
    if (cur && m && cur.status === "open" && run.availability[m.id]?.available !== false) {
      const choice = await provider.chooseSellerLever(cur, ask.lever, signal);
      run.modelCalls += choice.callsUsed;
      events.push(...modelEvents(`seller:${m.id}`, choice, now, job.id));
      leverUsed = NegotiationLever.safeParse(choice.value).success ? choice.value : ask.lever;
      reasoning = choice.reasoning;
      const demand = deriveDemand(requireRequirements(run));
      // Keep the offer's own requestVersion so the revision chain stays on the same offer id.
      const out = respond(m, cur, leverUsed, ask.round, { demand, requestVersion: cur.requestVersion, nowIso: now, reasoning }, ask.topup ? { topup: ask.topup } : {});
      reply = out.reply;
      if (out.outcome === "revised") {
        outcome = "revised";
        revised = pushOffer(run, out.offer);
      }
    }
    run.negotiation.push({
      id: ask.messageId,
      round: ask.round,
      offerId: ask.offerId,
      merchantId: ask.merchantId,
      lever: leverUsed,
      ask: short(ask.ask),
      outcome,
      reply: short(reply),
      ...(revised ? { resultRevision: revised.revision } : {}),
      reasoning,
    });
    const name = m?.name ?? ask.merchantId;
    if (revised && cur) {
      events.push(
        ev(
          "offer.revised",
          `${name} revised: ${formatCents(cur.totalCents)} → ${formatCents(revised.totalCents)}, ${fulfillmentLabel(revised)} (${reply})`,
          { offerId: revised.id, merchantId: revised.merchantId, lever: leverUsed, fromRevision: cur.revision, toRevision: revised.revision, reply, round: ask.round, offer: revised },
          now,
          job.id,
        ),
      );
    } else {
      events.push(ev("offer.declined", `${name} declined ${leverLabel(leverUsed)}: ${reply}`, { offerId: ask.offerId, merchantId: ask.merchantId, lever: leverUsed, reply, round: ask.round }, now, job.id));
    }
    if (lastInRound && ask.round >= MAX_ROUNDS) run.phase = afterNegotiation(job);
    return { run, events, paced: true, label: `negotiate:answer:${ask.messageId}` };
  }

  /** Fresh clearing: pick the best feasible candidate or explain infeasibility. */
  function clearStep(run: Run, job: Job, now: string): Step {
    const previous = run.orders.some(isActiveOrder) ? previousState(run) : undefined;
    const ctx = solveContext(run, now, previous);
    const open = latestOpenOffers(run.offers).length;
    const result = solve(ctx);
    const events: NewEvent[] = [
      ev("clearing.started", `Clearing: evaluating combinations of ${open} open offers`, { openOffers: open, mode: previous ? "repair" : "fresh" }, now, job.id),
      evaluatedEvent(result, previous ? "repair" : "fresh", now, job.id),
    ];
    if (result.best) {
      const plan = makePlan(run, ctx, result, result.best, now, previous ? basisPlan(run)?.revision : undefined);
      pushPlan(run, plan);
      run.phase = "proposed";
      events.push(ev("plan.proposed", `Plan r${plan.revision} proposed: ${plan.selections.map((s) => s.merchantName).join(" + ")} · ${formatCents(plan.totals.totalCents)}`, { plan }, now, job.id));
      events.push(
        ev(
          "market.cleared",
          `MARKET CLEARED: feasible proposed plan for the modelled requirements · ${formatCents(plan.totals.totalCents)}, ${plan.schedule.slackMinutes} min slack`,
          { planRevision: plan.revision, totalCents: plan.totals.totalCents, slackMinutes: plan.schedule.slackMinutes, remainingCents: plan.budget.remainingCents, meaning: "A feasible proposed solution exists for the modelled requirements; nothing has been ordered." },
          now,
          job.id,
        ),
      );
    } else {
      events.push(setInfeasible(run, ctx, result, now, job.id));
    }
    run.job = null;
    return { run, events, paced: false, label: "clear" };
  }

  /** Disrupted → (negotiating for headcount changes | repairing). */
  function startRepairStep(run: Run, job: Job, now: string): Step {
    const last = run.disruptions.at(-1);
    const negotiate = last?.input.type === "headcount_changed";
    run.phase = negotiate ? "negotiating" : "repairing";
    return {
      run,
      events: [ev("repair.started", negotiate ? "Repair started: re-negotiating re-quoted offers on the shortlist" : "Repair started: invalidating affected selections and re-solving", { disruptionId: last?.id ?? null, type: last?.input.type ?? null, negotiate, jobId: job.id }, now, job.id)],
      paced: false,
      label: "repair:start",
    };
  }

  /** Repair: fewest changes, then lowest exposure, then slack. */
  function repairStep(run: Run, job: Job, now: string): Step {
    const previous = previousState(run);
    const basis = basisPlan(run);
    const ctx = solveContext(run, now, previous);
    const result = solve(ctx);
    const events: NewEvent[] = [evaluatedEvent(result, previous ? "repair" : "fresh", now, job.id)];
    if (result.best) {
      const widened = previous ? explainWidened(run, ctx, result.best, previous) : undefined;
      const plan = makePlan(run, ctx, result, result.best, now, basis?.revision, widened);
      pushPlan(run, plan);
      run.phase = "needs_approval";
      const cs = plan.changeSummary;
      events.push(
        ev(
          "plan.repaired",
          `PLAN RECOVERED: r${plan.revision} ${formatCents(plan.totals.totalCents)} · kept ${cs.kept.length}, changed ${cs.added.length + cs.replaced.length}, removed ${cs.removed.length}; needs approval`,
          { plan, basedOnRevision: basis?.revision ?? null, changeSummary: cs },
          now,
          job.id,
        ),
      );
    } else {
      events.push(setInfeasible(run, ctx, result, now, job.id));
    }
    run.job = null;
    return { run, events, paced: false, label: "repair:solve" };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async function createPresetRun(withResetEvent = false): Promise<Run> {
    const now = clock.now();
    const input: RequestInput = {
      text: PRESET_TEXT,
      eventDate: nextDemoEventDate(new Date(now), DEFAULT_TIMEZONE),
      timezone: DEFAULT_TIMEZONE,
      nowLocal: DEFAULT_NOW_LOCAL,
    };
    const id = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const run: Run = {
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      requestVersion: 1,
      phase: "draft",
      reasoning: provider.mode,
      request: input,
      requirements: null,
      merchants: clone(publicCatalog),
      availability: Object.fromEntries(catalog.map((m) => [m.id, { available: true }])),
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
    const events: NewEvent[] = [];
    if (withResetEvent) events.push(ev("run.reset", "Demo reset: previous runs and events cleared", {}, now));
    events.push(ev("run.created", "Preset run created · demo suppliers, local rules, simulated orders", { runId: id, preset: true, merchants: publicCatalog.length }, now));
    store.insertRun(run, events);
    store.setCurrentRunId(id);
    return submitRequest(id, input);
  }

  async function getOrCreateCurrent(): Promise<Run> {
    const id = store.getCurrentRunId();
    const run = id ? store.getRun(id) : null;
    if (run) return run;
    if (!creating) {
      creating = createPresetRun().finally(() => {
        creating = null;
      });
    }
    return creating;
  }

  async function submitRequest(runId: string, raw: SubmitRequestCommand): Promise<Run> {
    const { idempotencyKey, ...input } = parseOrThrow(SubmitRequestCommand, raw);
    const cached = replay(runId, "request", idempotencyKey, fingerprintOf(raw));
    if (cached) return cached;
    load(runId);
    abortInflight(runId); // a running job's model calls are now stale
    const res = await provider.interpret(input.text);
    const requirements = buildRequirements(input, res.value, res.reasoning);
    return mutate(runId, "request", idempotencyKey, fingerprintOf(raw), (run, now) => {
      // The first interpretation of a draft is request version 1; later edits bump it.
      if (run.requirements !== null) run.requestVersion += 1;
      run.request = input;
      run.requirements = requirements;
      run.phase = "confirming";
      run.job = null;
      run.infeasibility = null;
      run.lastError = null;
      supersedeProposed(run);
      run.currentPlanRevision = latestApproved(run)?.revision ?? null;
      run.modelCalls += res.callsUsed;
      return {
        run,
        events: [
          ev("request.submitted", `Request submitted (request version ${run.requestVersion})`, { requestVersion: run.requestVersion, request: input }, now),
          ...modelEvents("interpret", res, now),
          ev("requirements.extracted", summarizeRequirements(requirements), { requirements, interpretedBy: requirements.interpretedBy, missing: requirements.missing }, now),
        ],
      };
    });
  }

  async function confirmRequirements(runId: string, raw: ConfirmCommand = {}): Promise<Run> {
    const cmd = parseOrThrow(ConfirmCommand, raw);
    const saved = mutate(runId, "confirm", cmd.idempotencyKey, fingerprintOf(raw), (run, now) => {
      if (run.phase !== "confirming") throw new PhaseError(`Requirements can only be confirmed in phase "confirming" (current: "${run.phase}").`, { phase: run.phase });
      const edits = cmd.edits ?? {};
      const next = applyEdits(requireRequirements(run), edits);
      if (next.missing.length > 0) throw new ValidationError("Some requirements are still missing.", { missing: next.missing }, "missing_requirements");
      if (Object.keys(edits).length > 0) run.requestVersion += 1;
      run.requirements = next;
      // Offers from an earlier request are retired; the market is collected afresh.
      const retired: string[] = [];
      for (const o of run.offers) {
        if (o.status === "open") {
          o.status = "superseded";
          retired.push(keyOf(o.id, o.revision));
        }
      }
      run.job = newJob(run, "collect", now);
      run.phase = "collecting";
      run.infeasibility = null;
      run.lastError = null;
      const suppliers = catalog.filter((m) => run.availability[m.id]?.available !== false).length;
      return {
        run,
        events: [
          ev("requirements.confirmed", `Requirements confirmed: ${summarizeRequirements(next)}`, { requirements: next, edits, requestVersion: run.requestVersion }, now),
          ev("market.opened", `Market opened to ${suppliers} demo suppliers (offer pacing is for readability only)`, { jobId: run.job.id, suppliers, retiredOffers: retired, paceMs: deps.paceMs }, now, run.job.id),
        ],
      };
    });
    schedule(saved);
    return saved;
  }

  async function advance(runId: string): Promise<AdvanceResult> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = load(runId);
      const job = current.job;
      if (!job) return { run: current, done: true, paced: false, step: "idle" };
      if (job.requestVersion !== current.requestVersion) {
        failJob(runId, job.id, "Request changed while the job was running; its results were discarded.");
        throw new StaleJob(`Job ${job.id} was started for request version ${job.requestVersion}, but the request is now version ${current.requestVersion}.`, { jobId: job.id });
      }
      const controller = new AbortController();
      inflight.set(runId, controller);
      const now = clock.now();
      let step: Step;
      try {
        step = await computeStep(clone(current), job, now, controller.signal);
      } finally {
        if (inflight.get(runId) === controller) inflight.delete(runId);
      }
      step.run.updatedAt = now;
      try {
        const saved = store.commit({ run: step.run, expectedVersion: current.version, events: step.events });
        return { run: saved, done: saved.job === null, paced: step.paced, step: step.label };
      } catch (err) {
        if (!(err instanceof VersionConflict)) throw err;
        const fresh = store.getRun(runId);
        if (!fresh || !fresh.job || fresh.job.id !== job.id || fresh.requestVersion !== job.requestVersion) {
          throw new StaleJob(`Job ${job.id} was superseded while it ran; its result was discarded.`, { jobId: job.id });
        }
        // Same job, unrelated concurrent write (e.g. a refund settled): recompute from fresh state.
      }
    }
    throw new VersionConflict("Pipeline step could not commit after repeated conflicts.");
  }

  async function drain(runId: string, maxSteps = 500): Promise<Run> {
    for (let i = 0; i < maxSteps; i++) {
      let r: AdvanceResult;
      try {
        r = await advance(runId);
      } catch (err) {
        if (err instanceof StaleJob) return load(runId);
        throw err;
      }
      if (r.done) return r.run;
      if (r.paced && deps.paceMs > 0) await sleep(deps.paceMs);
    }
    throw new Error(`Pipeline for ${runId} did not finish within ${maxSteps} steps.`);
  }

  function failJob(runId: string, jobId: string | undefined, reason: string): Run | null {
    try {
      return mutate(runId, "fail", undefined, undefined, (run, now) => {
        const job = run.job;
        if (!job || (jobId !== undefined && job.id !== jobId)) throw new StaleJob("No matching active job.");
        run.job = null;
        run.phase = run.requirements ? "confirming" : "draft";
        run.lastError = short(reason);
        return { run, events: [ev("job.failed", `Pipeline job ${job.id} failed: ${reason}`, { jobId: job.id, kind: job.kind, reason: short(reason) }, now, job.id)] };
      });
    } catch {
      return null;
    }
  }

  async function approve(runId: string, raw: ApproveCommand): Promise<Run> {
    const cmd = parseOrThrow(ApproveCommand, raw);
    return mutate(runId, "approve", cmd.idempotencyKey, fingerprintOf(raw), (run, now) => {
      const plan = run.plans.find((p) => p.revision === cmd.planRevision);
      if (!plan) throw new NotFound(`Plan revision ${cmd.planRevision} not found.`);
      if (run.phase !== "proposed" && run.phase !== "needs_approval") {
        throw new PhaseError(`Nothing to approve in phase "${run.phase}".`, { phase: run.phase });
      }
      if (plan.status !== "proposed" || run.currentPlanRevision !== plan.revision) {
        throw new PhaseError(`Plan revision ${plan.revision} is ${plan.status}; only the current proposed revision (${run.currentPlanRevision ?? "none"}) can be approved.`, { planRevision: plan.revision, status: plan.status, currentPlanRevision: run.currentPlanRevision }, "plan_not_current");
      }
      // Revalidate the exact (offerId, offerRevision) pairs at approval time.
      const offers = plan.selections.map((s) => run.offers.find((o) => o.id === s.offerId && o.revision === s.offerRevision));
      if (offers.some((o) => o === undefined)) throw new ApprovalRejected(["offer_not_open"], "A selected offer revision no longer exists.");
      const active = run.orders.filter(isActiveOrder);
      const c = validateCandidate(solveContext(run, now, { selections: [], activeOrders: active }), offers as Offer[]);
      if (!c.feasible) throw new ApprovalRejected(c.rejects, `Approval rejected on revalidation: ${c.rejects.join(", ")}.`);
      if (plan.requestVersion !== run.requestVersion) {
        throw new PhaseError(`Plan revision ${plan.revision} was built for request version ${plan.requestVersion}; the request is now version ${run.requestVersion}.`, undefined, "plan_stale");
      }

      const rev = plan.revision;
      const approvalId = `apr_${rev}_${run.approvals.length + 1}`;
      const events: NewEvent[] = [
        ev("plan.approved", `Plan r${rev} approved by the organizer · simulated spend ${formatCents(plan.totals.totalCents)}`, { planRevision: rev, approvalId, authorizedCents: plan.totals.totalCents, simulated: true }, now),
      ];
      const selectedKeys = new Set(plan.selections.map((s) => keyOf(s.offerId, s.offerRevision)));
      const selectedMerchants = new Set(plan.selections.map((s) => s.merchantId));
      for (const o of active) {
        if (selectedKeys.has(keyOf(o.offerId, o.offerRevision))) continue; // kept selection keeps its order
        const replaced = selectedMerchants.has(o.merchantId);
        events.push(
          ...closeOrder(
            run,
            o,
            replaced ? "superseded" : "cancelled",
            replaced ? `Replaced by ${o.merchantName}'s revised offer in approved plan r${rev} (carried forward, no cancellation fee)` : `Dropped by approved plan r${rev}`,
            now,
            undefined,
            replaced ? CARRY_FORWARD_TERMS : undefined,
          ),
        );
      }
      const placed: SimOrder[] = [];
      for (const s of plan.selections) {
        if (active.some((o) => isActiveOrder(o) && keyOf(o.offerId, o.offerRevision) === keyOf(s.offerId, s.offerRevision))) continue;
        const base = `ord_${rev}_${s.merchantId.replace(/^m-/, "")}`;
        const id = run.orders.some((o) => o.id === base) ? `${base}_${run.orders.length + 1}` : base;
        const order: SimOrder = { id, merchantId: s.merchantId, merchantName: s.merchantName, offerId: s.offerId, offerRevision: s.offerRevision, planRevision: rev, amountCents: s.totalCents, status: "simulated_placed", simulated: true, placedAt: now };
        run.orders.push(order);
        addLedger(run, "charge", id, s.totalCents, now);
        events.push(ev("order.simulated_placed", `Simulated order placed with ${s.merchantName}: ${formatCents(s.totalCents)} (simulated charge)`, { order: clone(order), simulated: true }, now));
        placed.push(order);
      }
      for (const o of placed) {
        o.status = "simulated_confirmed";
        events.push(ev("order.simulated_confirmed", `${o.merchantName} simulated-confirmed order ${o.id}`, { orderId: o.id, merchantId: o.merchantId, simulated: true }, now));
      }
      for (const p of run.plans) if (p.status === "approved") p.status = "superseded";
      plan.status = "approved";
      run.approvals.push({ id: approvalId, planRevision: rev, authorizedCents: plan.totals.totalCents, approvedAt: now, idempotencyKey: cmd.idempotencyKey });
      run.phase = "simulated_confirmed";
      run.infeasibility = null;
      return { run, events };
    });
  }

  async function disrupt(runId: string, raw: DisruptCommand): Promise<Run> {
    const cmd = parseOrThrow(DisruptCommand, raw);
    const saved = mutate(runId, "disrupt", cmd.idempotencyKey, fingerprintOf(raw), (run, now) => {
      if (run.job || !DISRUPTABLE_PHASES.includes(run.phase)) {
        throw new PhaseError(`Disruptions can be injected in phases ${DISRUPTABLE_PHASES.join(", ")} (current: "${run.phase}").`, { phase: run.phase });
      }
      const req = requireRequirements(run);
      const d = cmd.disruption;
      const disId = `dis_${run.disruptions.length + 1}`;
      const effects: NewEvent[] = [];
      let summary: string;

      if (d.type === "supplier_unavailable") {
        const m = run.merchants.find((x) => x.id === d.merchantId);
        if (!m) throw new NotFound(`Unknown merchant ${d.merchantId}.`);
        if (run.availability[m.id]?.available === false) throw new PhaseError(`${m.name} is already unavailable.`, { merchantId: m.id }, "already_unavailable");
        summary = `${m.name} cancelled (simulated supplier disruption)`;
        run.availability[m.id] = { available: false, reason: short(`${m.name} is unavailable (simulated cancellation)`) };
        for (const o of run.offers) {
          if (o.merchantId === m.id && o.status === "open") {
            o.status = "withdrawn";
            effects.push(ev("offer.withdrawn", `${m.name} withdrew offer ${o.id} r${o.revision}`, { offerId: o.id, revision: o.revision, merchantId: m.id }, now, disId));
          }
        }
        for (const o of run.orders) {
          if (o.merchantId === m.id && isActiveOrder(o)) effects.push(...closeOrder(run, o, "cancelled", `${m.name} became unavailable`, now, disId));
        }
      } else if (d.type === "delivery_delayed") {
        const cur = latestRevisionOf(run.offers, d.offerId);
        if (!cur) throw new NotFound(`Unknown offer ${d.offerId}.`);
        if (cur.status !== "open") throw new PhaseError(`Offer ${d.offerId} r${cur.revision} is ${cur.status}.`, { offerId: d.offerId, status: cur.status }, "offer_not_open");
        const delayed = pushOffer(run, delayOffer(cur, d.delayMinutes, now));
        summary = `${cur.merchantName} delayed ${d.delayMinutes} min: ${formatLocal(cur.fulfillment.timeLocal)} → ${formatLocal(delayed.fulfillment.timeLocal)}`;
        // The order on the old revision stays active until a repaired plan is approved.
        effects.push(ev("offer.requoted", `${cur.merchantName} re-quoted with a ${d.delayMinutes}-minute delay (r${cur.revision} → r${delayed.revision})`, { reason: "delivery_delayed", offerId: cur.id, merchantId: cur.merchantId, fromRevision: cur.revision, toRevision: delayed.revision, offer: delayed }, now, disId));
      } else {
        if (d.headcount === req.headcount) throw new ValidationError(`Headcount is already ${d.headcount}.`, { headcount: d.headcount }, "unchanged");
        summary = `Headcount changed ${req.headcount} → ${d.headcount}`;
        const nextReq = clone(req);
        nextReq.headcount = d.headcount;
        nextReq.vegetarianMin = Math.min(nextReq.vegetarianMin, d.headcount);
        nextReq.fieldStatus.headcount = "confirmed";
        nextReq.missing = nextReq.missing.filter((f) => f !== "headcount");
        effects.push(...requoteForRequirements(run, nextReq, now, disId));
      }

      const disruption: Disruption = { id: disId, at: now, input: d, summary: short(summary) };
      run.disruptions.push(disruption);
      run.job = newJob(run, "repair", now);
      run.phase = "disrupted";
      run.infeasibility = null;
      run.lastError = null;
      return { run, events: [ev("disruption.injected", `Disruption: ${summary}`, { disruption }, now, disId), ...effects] };
    });
    schedule(saved);
    return saved;
  }

  async function settleRefund(runId: string, raw: SettleRefundCommand): Promise<Run> {
    const cmd = parseOrThrow(SettleRefundCommand, raw);
    const saved = mutate(runId, "settle", cmd.idempotencyKey, fingerprintOf(raw), (run, now) => {
      const order = run.orders.find((o) => o.id === cmd.orderId);
      if (!order) throw new NotFound(`Order ${cmd.orderId} not found.`);
      const rows = run.ledger.filter((e) => e.orderId === order.id && e.kind === "refund_pending");
      if (rows.length === 0) throw new PhaseError(`Order ${order.id} has no pending refund.`, { orderId: order.id }, "no_pending_refund");
      let cents = 0;
      for (const r of rows) {
        r.kind = "refund_settled";
        r.at = now;
        cents += r.cents;
      }
      if (order.cancellation) order.cancellation.refundStatus = "settled";
      const events: NewEvent[] = [ev("refund.settled", `Simulated refund of ${formatCents(cents)} from ${order.merchantName} settled; budget exposure drops`, { orderId: order.id, cents, simulated: true }, now)];
      // A settled refund frees budget: re-evaluate a blocked plan automatically.
      if ((run.phase === "no_feasible_plan" || run.phase === "needs_approval" || run.phase === "proposed") && !run.job && run.requirements) startReevaluation(run, now, events, "refund_settled");
      return { run, events };
    });
    schedule(saved);
    return saved;
  }

  async function updateBudget(runId: string, raw: UpdateBudgetCommand): Promise<Run> {
    const cmd = parseOrThrow(UpdateBudgetCommand, raw);
    const saved = mutate(runId, "budget", cmd.idempotencyKey, fingerprintOf(raw), (run, now) => {
      if (isBusy(run)) throw new PhaseError(`The budget cannot change while the run is ${run.phase}.`, { phase: run.phase });
      const req = clone(requireRequirements(run));
      const previousBudgetCents = req.budgetCents;
      req.budgetCents = cmd.budgetCents;
      req.fieldStatus.budget = "confirmed";
      req.missing = req.missing.filter((f) => f !== "budget");
      run.requirements = Requirements.parse(req);
      run.requestVersion += 1;
      const events: NewEvent[] = [
        ev("request.submitted", `Budget changed ${formatCents(previousBudgetCents)} → ${formatCents(cmd.budgetCents)} (request version ${run.requestVersion})`, { kind: "budget_update", budgetCents: cmd.budgetCents, previousBudgetCents, requestVersion: run.requestVersion }, now),
      ];
      if (REEVALUATE_PHASES.includes(run.phase) && run.offers.length > 0) startReevaluation(run, now, events, "budget_update");
      return { run, events };
    });
    schedule(saved);
    return saved;
  }

  // -------------------------------------------------------------------------
  // Attendee opt-in (P1). The link token is a submit-only credential: it never
  // appears in an event payload, and nothing reachable with it reads or changes
  // the budget, plans, offers, orders, approvals or spending limits.
  // -------------------------------------------------------------------------

  /** The run behind a link token. NotFound for unknown tokens, and for disabled ones when `requireEnabled`. */
  function attendeeRun(token: string, requireEnabled: boolean): Run {
    const runId = ATTENDEE_TOKEN_RE.test(token) ? store.findRunIdByAttendeeToken(token) : null;
    const run = runId ? store.getRun(runId) : null;
    const link = run?.attendeeLink;
    if (!run || !link || !tokensEqual(link.token, token) || (requireEnabled && !link.enabled)) {
      throw new NotFound("This attendee link is not active.");
    }
    return run;
  }

  async function createAttendeeLink(runId: string, raw: AttendeeLinkCommand = {}): Promise<Run> {
    const cmd = parseOrThrow(AttendeeLinkCommand, raw);
    const fingerprint = fingerprintOf(raw);
    const cached = replay(runId, "attendee-link", cmd.idempotencyKey, fingerprint);
    if (cached) return cached;
    const current = load(runId);
    if (current.attendeeLink?.enabled) return current; // one active link per run: creating again returns it
    requireRequirements(current);
    const token = newAttendeeToken();
    // The mapping is written first; it resolves only while the run's own attendeeLink carries this token.
    store.putAttendeeLink(token, runId);
    return mutate(runId, "attendee-link", cmd.idempotencyKey, fingerprint, (run, now) => {
      if (run.attendeeLink?.enabled) return { run, events: [] };
      requireRequirements(run);
      const s = summarizeAttendees(store.listAttendeeResponses(run.id), run.attendeeSummary);
      run.attendeeLink = { token, enabled: true, createdAt: now };
      run.attendeeSummary = s;
      return {
        run,
        events: [ev("attendee.link_created", "Attendee link created", { enabled: true, responses: s.responses, people: s.people, vegetarian: s.vegetarian, flexible: s.flexible }, now)],
      };
    });
  }

  async function submitAttendee(raw: AttendeeSubmitCommand): Promise<AttendeePublicView> {
    const cmd = parseOrThrow(AttendeeSubmitCommand, raw);
    const run = attendeeRun(cmd.token, true);
    const existing = store.listAttendeeResponses(run.id);
    const prior = existing.find((r) => r.respondentId === cmd.respondentId);
    if (prior && prior.preference === cmd.preference && prior.partySize === cmd.partySize) return attendeePublicView(run);
    if (!prior && existing.length >= MAX_ATTENDEE_RESPONSES) {
      throw new PhaseError(`This attendee link has reached its limit of ${MAX_ATTENDEE_RESPONSES} responses.`, undefined, "attendee_limit");
    }
    store.upsertAttendeeResponse(run.id, { respondentId: cmd.respondentId, preference: cmd.preference, partySize: cmd.partySize, submittedAt: clock.now() });
    const saved = mutate(run.id, "attendee", undefined, undefined, (r, now) => {
      if (!r.attendeeLink?.enabled || !tokensEqual(r.attendeeLink.token, cmd.token)) throw new NotFound("This attendee link is not active.");
      // Recomputed from every stored answer, so concurrent submissions converge on the same counts.
      const s = summarizeAttendees(store.listAttendeeResponses(r.id), r.attendeeSummary);
      r.attendeeSummary = s;
      return {
        run: r,
        events: [
          ev("attendee.responded", `Attendee responses: ${s.responses} · ${s.people} people (${s.vegetarian} vegetarian, ${s.flexible} flexible)`, { responses: s.responses, people: s.people, vegetarian: s.vegetarian, flexible: s.flexible }, now),
        ],
      };
    });
    return attendeePublicView(saved);
  }

  function getAttendeeView(token: string): AttendeePublicView {
    return attendeePublicView(attendeeRun(token, false));
  }

  async function applyAttendeeCounts(runId: string, raw: AttendeeApplyCommand): Promise<Run> {
    const cmd = parseOrThrow(AttendeeApplyCommand, raw);
    const saved = mutate(runId, "attendee-apply", cmd.idempotencyKey, fingerprintOf(raw), (run, now) => {
      if (!run.attendeeLink) throw new PhaseError("Create an attendee link first.", undefined, "no_attendee_link");
      const s = summarizeAttendees(store.listAttendeeResponses(run.id), run.attendeeSummary);
      if (s.responses === 0) throw new PhaseError("No attendee responses yet; there is nothing to apply.", undefined, "no_attendee_responses");
      const requirementsOnly = run.phase === "confirming" && !run.job;
      if (!requirementsOnly && (run.job || !DISRUPTABLE_PHASES.includes(run.phase))) {
        throw new PhaseError(`Attendee counts can be applied in phases confirming, ${DISRUPTABLE_PHASES.join(", ")} (current: "${run.phase}").`, { phase: run.phase });
      }
      const req = requireRequirements(run);
      if (s.people === req.headcount && s.vegetarian === req.vegetarianMin) {
        throw new ValidationError(`Requirements already match the attendee counts (${s.people} people, ${s.vegetarian} vegetarian).`, { headcount: s.people, vegetarianMin: s.vegetarian }, "unchanged");
      }
      const next = applyEdits(req, { headcount: s.people, vegetarianMin: s.vegetarian });
      next.assumptions = [...next.assumptions.slice(0, 19), { field: "headcount", note: `Counts applied from ${s.responses} attendee response${s.responses === 1 ? "" : "s"}` }];
      const nextReq = Requirements.parse(next);
      run.attendeeSummary = { ...s, appliedAt: now, appliedPeople: s.people };
      const change = `headcount ${req.headcount} → ${s.people}, vegetarian ${req.vegetarianMin} → ${s.vegetarian}`;
      const events: NewEvent[] = [
        ev(
          "attendee.applied",
          `Attendee counts applied (${s.responses} responses): ${change}`,
          { responses: s.responses, people: s.people, vegetarian: s.vegetarian, flexible: s.flexible, previous: { headcount: req.headcount, vegetarianMin: req.vegetarianMin }, repair: !requirementsOnly },
          now,
        ),
      ];
      if (requirementsOnly) {
        run.requestVersion += 1;
        run.requirements = nextReq;
        return { run, events };
      }
      // A plan exists: the same path as a headcount_changed disruption (re-quote, re-negotiate, repair, fresh approval).
      const disId = `dis_${run.disruptions.length + 1}`;
      const effects = requoteForRequirements(run, nextReq, now, disId);
      const disruption: Disruption = { id: disId, at: now, input: { type: "headcount_changed", headcount: s.people }, summary: short(`Attendee counts applied: ${change}`) };
      run.disruptions.push(disruption);
      run.job = newJob(run, "repair", now);
      run.phase = "disrupted";
      run.infeasibility = null;
      run.lastError = null;
      events.push(ev("disruption.injected", `Disruption: ${disruption.summary}`, { disruption, source: "attendee_counts" }, now, disId), ...effects);
      return { run, events };
    });
    schedule(saved);
    return saved;
  }

  async function reset(): Promise<Run> {
    abortInflight();
    store.deleteAll();
    return createPresetRun(true);
  }

  return {
    paceMs: deps.paceMs,
    reasoning: provider.mode,
    getRun: (runId) => store.getRun(runId),
    currentRunId: () => store.getCurrentRunId(),
    listEvents: (runId, afterSeq = 0, limit = 1000) => store.listEvents(runId, afterSeq, limit),
    createPresetRun: () => createPresetRun(false),
    getOrCreateCurrent,
    submitRequest,
    confirmRequirements,
    advance,
    drain,
    approve,
    disrupt,
    settleRefund,
    updateBudget,
    reset,
    failJob,
    createAttendeeLink,
    submitAttendee,
    getAttendeeView,
    applyAttendeeCounts,
  };
}
