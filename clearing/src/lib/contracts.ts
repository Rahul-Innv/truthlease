/**
 * Shared contracts for Clearing.
 *
 * One authoritative schema per boundary. Everything that crosses the
 * browser ↔ server boundary, the store boundary, or the model boundary is
 * validated against these schemas. All money is integer cents.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const Cents = z.number().int().min(0).max(50_000_000);
export const Qty = z.number().int().min(0).max(5_000);
export const Id = z.string().min(1).max(80);
export const ShortText = z.string().max(200);
export const LongText = z.string().max(4_000);
/** Local wall-clock time on the event date, "HH:MM" 24h. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CapabilityGroup = z.enum(["meals", "drinks_consumables", "delivery"]);
export type CapabilityGroup = z.infer<typeof CapabilityGroup>;

export const ItemKind = z.enum([
  "meal_vegetarian",
  "meal_standard",
  "drink_serving",
  "plate",
  "utensil_set",
  "delivery_run",
]);
/** Item kinds that represent organizer demand (delivery_run is a fulfillment service). */
export const DEMAND_ITEM_KINDS = ["meal_vegetarian", "meal_standard", "drink_serving", "plate", "utensil_set"] as const;
export type ItemKind = z.infer<typeof ItemKind>;

export const FulfillmentMode = z.enum(["included_delivery", "pickup_only", "courier"]);
export type FulfillmentMode = z.infer<typeof FulfillmentMode>;

export const ReasoningMode = z.enum(["local", "live"]);
export type ReasoningMode = z.infer<typeof ReasoningMode>;

// ---------------------------------------------------------------------------
// Request & requirements
// ---------------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimeZone = z.string().min(1).max(64).refine(isValidTimeZone, { message: "Unknown IANA time zone" });

export const RequestInput = z.object({
  text: z.string().min(1).max(2_000),
  eventDate: IsoDate,
  timezone: TimeZone,
  /** Simulated "now" on the event date (labelled as a simulated event clock). */
  nowLocal: LocalTime,
  venueName: ShortText.optional(),
});
export type RequestInput = z.infer<typeof RequestInput>;

export const FieldStatus = z.enum(["confirmed", "assumed", "missing"]);
export type FieldStatus = z.infer<typeof FieldStatus>;

export const RequirementField = z.enum([
  "objective",
  "venue",
  "timezone",
  "eventDate",
  "readyBy",
  "headcount",
  "vegetarianMin",
  "drinks",
  "plates",
  "utensils",
  "budget",
]);
export type RequirementField = z.infer<typeof RequirementField>;

export const Requirements = z.object({
  objective: ShortText,
  venue: z.object({ name: ShortText, zone: z.string().max(40), fictional: z.boolean() }),
  timezone: z.string().max(64),
  eventDate: IsoDate,
  nowLocal: LocalTime,
  readyByLocal: LocalTime,
  setupBufferMinutes: z.number().int().min(0).max(240),
  headcount: Qty.min(1),
  vegetarianMin: Qty,
  items: z.object({ drinks: z.boolean(), plates: z.boolean(), utensils: z.boolean() }),
  preferences: z.array(ShortText).max(20),
  budgetCents: Cents,
  fieldStatus: z.record(RequirementField, FieldStatus),
  assumptions: z.array(z.object({ field: RequirementField, note: ShortText })).max(20),
  missing: z.array(RequirementField).max(20),
  /** Which component produced this interpretation. */
  interpretedBy: ReasoningMode,
});
export type Requirements = z.infer<typeof Requirements>;

// ---------------------------------------------------------------------------
// Merchants (fictional demo catalog)
// ---------------------------------------------------------------------------

export const CatalogItem = z.object({
  sku: Id,
  label: ShortText,
  kind: ItemKind,
  unitCents: Cents,
  minQty: Qty,
  maxQty: Qty,
});
export type CatalogItem = z.infer<typeof CatalogItem>;

export const Slot = z.object({
  id: Id,
  label: ShortText,
  /** Courier / included-delivery: arrival at venue. Pickup-only: ready at merchant. */
  timeLocal: LocalTime,
  /** Courier only: pickups must be ready by this time. */
  pickupByLocal: LocalTime.optional(),
});
export type Slot = z.infer<typeof Slot>;

export const CancellationTerms = z.object({
  refundablePct: z.number().int().min(0).max(100),
  settlement: z.enum(["immediate", "pending"]),
  note: ShortText,
});
export type CancellationTerms = z.infer<typeof CancellationTerms>;

/** Buyer-visible merchant profile. Never contains negotiation policy. */
export const MerchantPublic = z.object({
  id: Id,
  name: ShortText,
  tagline: ShortText,
  group: CapabilityGroup,
  fictional: z.literal(true),
  provenance: z.literal("demo_catalog"),
  serviceZones: z.array(z.string().max(40)).min(1),
  capacity: z.object({
    maxMeals: Qty.optional(),
    maxDrinkServings: Qty.optional(),
    maxPickups: Qty.optional(),
  }),
  minMeals: Qty.optional(),
  fulfillment: z.object({
    mode: FulfillmentMode,
    deliveryFeeCents: Cents.optional(),
    slots: z.array(Slot).min(1),
    defaultSlotId: Id,
  }),
  serviceFeePct: z.number().int().min(0).max(30),
  leadTimeMinutes: z.number().int().min(0).max(24 * 60),
  catalog: z.array(CatalogItem).min(1),
  cancellation: CancellationTerms,
  /** Free text supplied by the merchant. Untrusted; displayed as data only. */
  description: LongText,
});
export type MerchantPublic = z.infer<typeof MerchantPublic>;

/** Private seller policy. Lives only on the server; never serialised to the buyer or UI. */
export const SellerPolicy = z.object({
  /** Lowest unit price the seller will accept, as a percentage of list. */
  floorPctOfList: z.number().int().min(50).max(100),
  volumeDiscount: z.array(z.object({ minQty: Qty, pct: z.number().int().min(1).max(40) })),
  slotFlexible: z.boolean(),
  /** Maximum number of concession rounds this seller participates in. */
  maxRounds: z.number().int().min(0).max(2),
});
export type SellerPolicy = z.infer<typeof SellerPolicy>;

export const Merchant = MerchantPublic.extend({ policy: SellerPolicy });
export type Merchant = z.infer<typeof Merchant>;

export const Availability = z.object({
  available: z.boolean(),
  reason: ShortText.optional(),
});
export type Availability = z.infer<typeof Availability>;

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export const OfferLine = z.object({
  sku: Id,
  label: ShortText,
  kind: ItemKind,
  qty: Qty,
  unitCents: Cents,
  lineCents: Cents,
});
export type OfferLine = z.infer<typeof OfferLine>;

export const OfferFee = z.object({ label: ShortText, cents: Cents });

export const OfferStatus = z.enum(["open", "superseded", "withdrawn", "expired"]);
export type OfferStatus = z.infer<typeof OfferStatus>;

export const NegotiationLever = z.enum(["volume_discount", "earlier_slot", "later_pickup", "quantity_topup"]);
export type NegotiationLever = z.infer<typeof NegotiationLever>;

export const Offer = z.object({
  id: Id,
  merchantId: Id,
  merchantName: ShortText,
  group: CapabilityGroup,
  revision: z.number().int().min(1),
  supersedesRevision: z.number().int().min(1).optional(),
  status: OfferStatus,
  requestVersion: z.number().int().min(1),
  lines: z.array(OfferLine).min(1),
  fees: z.array(OfferFee),
  /** Delivery line. null when the offer has no delivery component (pickup-only). */
  deliveryCents: Cents.nullable(),
  totalCents: Cents,
  fulfillment: z.object({
    mode: FulfillmentMode,
    slotId: Id,
    /** included_delivery/courier: arrival at venue. pickup_only: ready for pickup. */
    timeLocal: LocalTime,
    pickupByLocal: LocalTime.optional(),
    maxPickups: Qty.optional(),
  }),
  expiresAt: z.string().datetime(),
  /** Present when the seller can serve only part of the meal demand (supply assembly). */
  partial: z.object({ coversMeals: Qty, ofMeals: Qty }).optional(),
  conditions: z.array(ShortText).max(10),
  /** Required costs the seller could not price. Non-empty ⇒ not fully priced. */
  unpriced: z.array(ShortText).max(5),
  provenance: z.object({
    supply: z.literal("demo_catalog"),
    reasoning: ReasoningMode,
    round: z.number().int().min(0).max(2),
    note: ShortText,
  }),
  createdAt: z.string().datetime(),
});
export type Offer = z.infer<typeof Offer>;

export const NegotiationMessage = z.object({
  id: Id,
  round: z.number().int().min(1).max(2),
  offerId: Id,
  merchantId: Id,
  lever: NegotiationLever,
  ask: ShortText,
  outcome: z.enum(["revised", "declined"]),
  reply: ShortText,
  resultRevision: z.number().int().min(1).optional(),
  reasoning: ReasoningMode,
});
export type NegotiationMessage = z.infer<typeof NegotiationMessage>;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const RejectCode = z.enum([
  "incomplete_coverage",
  "dietary_shortfall",
  "capacity_exceeded",
  "below_min_order",
  "offer_not_open",
  "offer_expired",
  "merchant_unavailable",
  "duplicate_merchant",
  "service_area",
  "needs_delivery",
  "delivery_unused",
  "courier_capacity",
  "pickup_too_late",
  "arrival_too_late",
  "not_fully_priced",
  "over_budget",
  "too_many_meal_offers",
]);
export type RejectCode = z.infer<typeof RejectCode>;

export const ChangeKind = z.enum(["kept", "added", "replaced", "requoted"]);

export const PlanSelection = z.object({
  offerId: Id,
  offerRevision: z.number().int().min(1),
  merchantId: Id,
  merchantName: ShortText,
  group: CapabilityGroup,
  totalCents: Cents,
  coverage: z.record(ItemKind, Qty),
  /** Courier only: the pickup-only offers it carries. */
  deliversFor: z.array(Id).optional(),
  change: ChangeKind,
  replacesMerchantId: Id.optional(),
});
export type PlanSelection = z.infer<typeof PlanSelection>;

export const CoverageRow = z.object({ required: Qty, supplied: Qty });

export const BudgetView = z.object({
  budgetCents: Cents,
  planCents: Cents,
  /** Simulated charges held by cancelled suppliers (nonrefundable). */
  retainedCents: Cents,
  /** Refunds not yet settled; never restore spendable budget. */
  pendingRefundCents: Cents,
  exposureCents: Cents,
  remainingCents: z.number().int(),
});
export type BudgetView = z.infer<typeof BudgetView>;

export const PlanStatus = z.enum(["proposed", "approved", "superseded", "infeasible"]);

export const Plan = z.object({
  revision: z.number().int().min(1),
  basedOnRevision: z.number().int().min(1).optional(),
  requestVersion: z.number().int().min(1),
  status: PlanStatus,
  selections: z.array(PlanSelection),
  coverage: z.record(ItemKind, CoverageRow),
  totals: z.object({
    goodsCents: Cents,
    feesCents: Cents,
    deliveryCents: Cents,
    totalCents: Cents,
  }),
  budget: BudgetView,
  schedule: z.object({
    readyByLocal: LocalTime,
    latestArrivalLocal: LocalTime,
    lastArrivalLocal: LocalTime,
    slackMinutes: z.number().int(),
  }),
  unresolvedConditions: z.array(ShortText),
  fullyPriced: z.boolean(),
  changeSummary: z.object({
    kept: z.array(ShortText),
    added: z.array(ShortText),
    removed: z.array(ShortText),
    replaced: z.array(z.object({ from: ShortText, to: ShortText, why: ShortText })),
    widened: ShortText.optional(),
  }),
  evaluation: z.object({
    candidatesChecked: z.number().int(),
    feasibleCandidates: z.number().int(),
    rejectedByReason: z.record(RejectCode, z.number().int()),
    solverMs: z.number().int(),
    scope: z.literal("optimal among evaluated candidates only"),
  }),
  reason: ShortText,
  createdAt: z.string().datetime(),
});
export type Plan = z.infer<typeof Plan>;

export const Infeasibility = z.object({
  kind: z.enum(["over_budget", "no_supply", "timing", "missing_information", "capacity"]),
  summary: ShortText,
  details: z.array(ShortText).max(12),
  cheapestInvalid: z
    .object({
      totalCents: Cents,
      budgetGapCents: Cents,
      merchants: z.array(ShortText),
      failing: z.array(RejectCode),
    })
    .optional(),
  evaluation: z.object({
    candidatesChecked: z.number().int(),
    rejectedByReason: z.record(RejectCode, z.number().int()),
    solverMs: z.number().int(),
  }),
});
export type Infeasibility = z.infer<typeof Infeasibility>;

// ---------------------------------------------------------------------------
// Approval, simulated orders, ledger
// ---------------------------------------------------------------------------

export const Approval = z.object({
  id: Id,
  planRevision: z.number().int().min(1),
  authorizedCents: Cents,
  approvedAt: z.string().datetime(),
  idempotencyKey: Id,
});
export type Approval = z.infer<typeof Approval>;

export const OrderStatus = z.enum([
  "simulated_placed",
  "simulated_confirmed",
  "cancelled",
  "superseded",
]);

export const SimOrder = z.object({
  id: Id,
  merchantId: Id,
  merchantName: ShortText,
  offerId: Id,
  offerRevision: z.number().int().min(1),
  planRevision: z.number().int().min(1),
  amountCents: Cents,
  status: OrderStatus,
  simulated: z.literal(true),
  placedAt: z.string().datetime(),
  cancellation: z
    .object({
      reason: ShortText,
      retainedCents: Cents,
      refundCents: Cents,
      refundStatus: z.enum(["settled", "pending", "none"]),
      cancelledAt: z.string().datetime(),
    })
    .optional(),
});
export type SimOrder = z.infer<typeof SimOrder>;

export const LedgerEntry = z.object({
  id: Id,
  kind: z.enum(["charge", "refund_settled", "refund_pending", "retained"]),
  orderId: Id,
  cents: Cents,
  at: z.string().datetime(),
  simulated: z.literal(true),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ---------------------------------------------------------------------------
// Disruptions
// ---------------------------------------------------------------------------

export const DisruptionInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("supplier_unavailable"), merchantId: Id }),
  z.object({
    type: z.literal("delivery_delayed"),
    offerId: Id,
    delayMinutes: z.number().int().min(5).max(240),
  }),
  z.object({ type: z.literal("headcount_changed"), headcount: Qty.min(1) }),
]);
export type DisruptionInput = z.infer<typeof DisruptionInput>;

export const Disruption = z.object({
  id: Id,
  at: z.string().datetime(),
  input: DisruptionInput,
  summary: ShortText,
});
export type Disruption = z.infer<typeof Disruption>;

// ---------------------------------------------------------------------------
// Attendee opt-in (P1 group demand). Minimal identifiers; never personal data.
// ---------------------------------------------------------------------------

export const AttendeePreference = z.enum(["vegetarian", "flexible"]);
export type AttendeePreference = z.infer<typeof AttendeePreference>;

export const AttendeeResponse = z.object({
  /** Random per-browser id so a person can update their own answer; never an identity. */
  respondentId: Id,
  preference: AttendeePreference,
  partySize: z.number().int().min(1).max(6),
  submittedAt: z.string().datetime(),
});
export type AttendeeResponse = z.infer<typeof AttendeeResponse>;

export const AttendeeSubmitCommand = z.object({
  token: Id,
  respondentId: Id,
  preference: AttendeePreference,
  partySize: z.number().int().min(1).max(6),
});

export const AttendeeSummary = z.object({
  responses: z.number().int().min(0),
  people: z.number().int().min(0),
  vegetarian: z.number().int().min(0),
  flexible: z.number().int().min(0),
  /** Set when the organizer last applied these counts to the requirements. */
  appliedAt: z.string().datetime().nullable(),
  appliedPeople: z.number().int().min(0).nullable(),
});
export type AttendeeSummary = z.infer<typeof AttendeeSummary>;

export const AttendeeLink = z.object({
  /** Unguessable token in the public URL. Grants submit-only access. */
  token: Id,
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type AttendeeLink = z.infer<typeof AttendeeLink>;

// ---------------------------------------------------------------------------
// Run (authoritative state) and events
// ---------------------------------------------------------------------------

export const Phase = z.enum([
  "draft",
  "confirming",
  "collecting",
  "negotiating",
  "clearing",
  "proposed",
  "approved",
  "simulated_confirmed",
  "disrupted",
  "repairing",
  "needs_approval",
  "no_feasible_plan",
]);
export type Phase = z.infer<typeof Phase>;

export const IntegrationStatus = z.object({
  reasoning: z.object({ mode: ReasoningMode, provider: ShortText, verified: z.boolean() }),
  supply: z.literal("Fictional demo catalog"),
  /** "BAND room" only when BAND_BUYER_* is configured; "(live-verified)" only after a seller reply arrived through BAND in this process. */
  coordination: z.enum(["Local transport", "BAND room (unverified; local fallback)", "BAND room (live-verified)"]),
  execution: z.literal("Simulated orders"),
  tavily: z.object({ connected: z.boolean(), note: ShortText }),
  zoowork: z.object({ connected: z.boolean(), note: ShortText }),
  band: z.object({ connected: z.boolean(), note: ShortText }),
  paceMs: z.number().int().min(0),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

export const Run = z.object({
  id: Id,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Optimistic concurrency token for the whole run row. */
  version: z.number().int().min(1),
  /** Increments whenever the request or requirements change. */
  requestVersion: z.number().int().min(1),
  phase: Phase,
  reasoning: ReasoningMode,
  request: RequestInput,
  requirements: Requirements.nullable(),
  merchants: z.array(MerchantPublic),
  availability: z.record(Id, Availability),
  offers: z.array(Offer),
  negotiation: z.array(NegotiationMessage),
  plans: z.array(Plan),
  currentPlanRevision: z.number().int().min(1).nullable(),
  approvals: z.array(Approval),
  orders: z.array(SimOrder),
  ledger: z.array(LedgerEntry),
  disruptions: z.array(Disruption),
  infeasibility: Infeasibility.nullable(),
  job: z
    .object({
      id: Id,
      kind: z.enum(["collect", "repair"]),
      requestVersion: z.number().int().min(1),
      startedAt: z.string().datetime(),
    })
    .nullable(),
  lastSeq: z.number().int().min(0),
  modelCalls: z.number().int().min(0),
  lastError: ShortText.nullable(),
  /** P1 group demand. Optional so runs stored before the feature still parse. */
  attendeeLink: AttendeeLink.nullable().optional(),
  attendeeSummary: AttendeeSummary.optional(),
});
export type Run = z.infer<typeof Run>;

export const EventType = z.enum([
  "run.created",
  "run.reset",
  "request.submitted",
  "requirements.extracted",
  "requirements.confirmed",
  "market.opened",
  "supplier.entered",
  "supplier.skipped",
  "offer.received",
  "negotiation.requested",
  "offer.revised",
  "offer.declined",
  "clearing.started",
  "clearing.evaluated",
  "plan.proposed",
  "market.cleared",
  "plan.infeasible",
  "plan.approved",
  "order.simulated_placed",
  "order.simulated_confirmed",
  "disruption.injected",
  "offer.withdrawn",
  "offer.requoted",
  "order.cancelled",
  "refund.pending",
  "refund.settled",
  "repair.started",
  "plan.repaired",
  "job.failed",
  "model.call",
  "model.fallback",
  "attendee.link_created",
  "attendee.responded",
  "attendee.applied",
]);
export type EventType = z.infer<typeof EventType>;

export const RunEvent = z.object({
  id: Id,
  runId: Id,
  seq: z.number().int().min(1),
  type: EventType,
  at: z.string().datetime(),
  causeId: Id.optional(),
  /** Short human-readable summary for the history panel. */
  summary: ShortText,
  payload: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEvent>;

// ---------------------------------------------------------------------------
// Commands (API inputs)
// ---------------------------------------------------------------------------

export const IdempotencyKey = z.string().min(8).max(80);

export const ApproveCommand = z.object({
  planRevision: z.number().int().min(1),
  idempotencyKey: IdempotencyKey,
});
export type ApproveCommand = z.infer<typeof ApproveCommand>;

export const DisruptCommand = z.object({
  disruption: DisruptionInput,
  idempotencyKey: IdempotencyKey,
});
export type DisruptCommand = z.infer<typeof DisruptCommand>;

export const SettleRefundCommand = z.object({
  orderId: Id,
  idempotencyKey: IdempotencyKey,
});

export const UpdateBudgetCommand = z.object({
  budgetCents: Cents,
  idempotencyKey: IdempotencyKey,
});

// ---------------------------------------------------------------------------
// Model-boundary schemas (validated outputs from a live model, never trusted
// for identifiers, totals, or authority).
// ---------------------------------------------------------------------------

export const ModelRequirementsOutput = z.object({
  objective: z.string().max(200),
  headcount: z.number().int().min(1).max(5000).nullable(),
  vegetarianMin: z.number().int().min(0).max(5000).nullable(),
  readyByLocal: z.string().max(5).nullable(),
  budgetCents: z.number().int().min(0).max(50_000_000).nullable(),
  wantsDrinks: z.boolean(),
  wantsPlates: z.boolean(),
  wantsUtensils: z.boolean(),
  preferences: z.array(z.string().max(120)).max(10),
});
export type ModelRequirementsOutput = z.infer<typeof ModelRequirementsOutput>;

export const ModelCounterSuggestion = z.object({
  offerRef: z.string().max(80),
  lever: NegotiationLever,
  reason: z.string().max(160),
});
export const ModelBuyerOutput = z.object({
  suggestions: z.array(ModelCounterSuggestion).max(6),
});
export type ModelBuyerOutput = z.infer<typeof ModelBuyerOutput>;

/** A seller agent picks which permitted lever it will concede on (may differ from the ask). */
export const ModelSellerOutput = z.object({
  lever: NegotiationLever,
  reason: z.string().max(160),
});
export type ModelSellerOutput = z.infer<typeof ModelSellerOutput>;
