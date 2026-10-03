/**
 * Display vocabulary for the console. Pure functions and lookup tables only;
 * nothing here decides feasibility, totals or authority.
 */
import type {
  CapabilityGroup,
  FieldStatus,
  FulfillmentMode,
  ItemKind,
  Offer,
  Phase,
  Plan,
  RejectCode,
  RequirementField,
  Run,
} from "@/lib/contracts";
import { formatCents } from "@/lib/money";
import { formatLocal } from "@/lib/time";

export { formatCents, formatLocal };

export type Tone = "neutral" | "mint" | "amber" | "red" | "accent";
export type Glyph = "dot" | "ring" | "check" | "cross" | "warn" | "half" | "dash" | "plus" | "swap" | "clock";

export const GROUP_LABEL: Record<CapabilityGroup, string> = {
  meals: "Meals",
  drinks_consumables: "Drinks & consumables",
  delivery: "Delivery",
};

export const GROUPS: CapabilityGroup[] = ["meals", "drinks_consumables", "delivery"];

export const ITEM_LABEL: Record<ItemKind, string> = {
  meal_vegetarian: "Vegetarian meals",
  meal_standard: "Standard meals",
  drink_serving: "Drink servings",
  plate: "Plates",
  utensil_set: "Utensil sets",
  delivery_run: "Delivery runs",
};

export const MODE_LABEL: Record<FulfillmentMode, string> = {
  included_delivery: "Delivery included",
  pickup_only: "Pickup only",
  courier: "Courier run",
};

export const FIELD_LABEL: Record<RequirementField, string> = {
  objective: "Objective",
  venue: "Venue",
  timezone: "Timezone",
  eventDate: "Event date",
  readyBy: "Ready by",
  headcount: "Headcount",
  vegetarianMin: "Vegetarian (min)",
  drinks: "Drinks",
  plates: "Plates",
  utensils: "Utensils",
  budget: "Budget",
};

export const FIELD_STATUS_META: Record<FieldStatus, { label: string; tone: Tone; glyph: Glyph }> = {
  confirmed: { label: "Confirmed", tone: "mint", glyph: "check" },
  assumed: { label: "Assumed", tone: "amber", glyph: "warn" },
  missing: { label: "Missing", tone: "red", glyph: "cross" },
};

export const REJECT_LABEL: Record<RejectCode, string> = {
  incomplete_coverage: "Does not cover every required item",
  dietary_shortfall: "Too few vegetarian meals",
  capacity_exceeded: "Over supplier capacity",
  below_min_order: "Below supplier minimum order",
  offer_not_open: "Offer is no longer open",
  offer_expired: "Offer expired",
  merchant_unavailable: "Supplier unavailable",
  duplicate_merchant: "Two offers from one supplier",
  service_area: "Outside the supplier's service area",
  needs_delivery: "Pickup order with no courier",
  delivery_unused: "Courier with nothing to carry",
  courier_capacity: "Courier cannot make that many pickups",
  pickup_too_late: "Ready after the courier's pickup cutoff",
  arrival_too_late: "Arrives after the setup cutoff",
  not_fully_priced: "Not fully priced",
  over_budget: "Over budget",
};

export interface PhaseMeta {
  label: string;
  tone: Tone;
  glyph: Glyph;
  /** Server is working; commands that need a settled state are unavailable. */
  busy: boolean;
}

export const PHASE_META: Record<Phase, PhaseMeta> = {
  draft: { label: "Draft", tone: "neutral", glyph: "ring", busy: false },
  confirming: { label: "Confirm requirements", tone: "amber", glyph: "warn", busy: false },
  collecting: { label: "Collecting offers", tone: "accent", glyph: "half", busy: true },
  negotiating: { label: "Negotiating", tone: "accent", glyph: "half", busy: true },
  clearing: { label: "Clearing", tone: "accent", glyph: "half", busy: true },
  proposed: { label: "Plan proposed", tone: "amber", glyph: "warn", busy: false },
  approved: { label: "Approved", tone: "mint", glyph: "check", busy: true },
  simulated_confirmed: { label: "Simulated orders confirmed", tone: "mint", glyph: "check", busy: false },
  disrupted: { label: "Disrupted", tone: "red", glyph: "cross", busy: true },
  repairing: { label: "Repairing", tone: "accent", glyph: "half", busy: true },
  needs_approval: { label: "Repaired · needs approval", tone: "amber", glyph: "warn", busy: false },
  no_feasible_plan: { label: "No feasible plan", tone: "red", glyph: "cross", busy: false },
};

export const ORDER_STATUS_META: Record<string, { label: string; tone: Tone; glyph: Glyph }> = {
  simulated_placed: { label: "Simulated · placed", tone: "accent", glyph: "half" },
  simulated_confirmed: { label: "Simulated · confirmed", tone: "mint", glyph: "check" },
  cancelled: { label: "Cancelled", tone: "red", glyph: "cross" },
  superseded: { label: "Superseded", tone: "neutral", glyph: "dash" },
};

export const CHANGE_META: Record<string, { label: string; tone: Tone; glyph: Glyph }> = {
  kept: { label: "Kept", tone: "neutral", glyph: "check" },
  added: { label: "Added", tone: "accent", glyph: "plus" },
  replaced: { label: "Replaced", tone: "amber", glyph: "swap" },
  requoted: { label: "Re-quoted", tone: "amber", glyph: "clock" },
};

export function currentPlan(run: Run): Plan | null {
  if (run.currentPlanRevision == null) return null;
  return run.plans.find((p) => p.revision === run.currentPlanRevision) ?? null;
}

/** The plan the console treats as "in force" for highlighting: current, same request, not superseded by an infeasible result. */
export function activePlan(run: Run): Plan | null {
  const p = currentPlan(run);
  if (!p) return null;
  if (p.requestVersion !== run.requestVersion) return null;
  if (run.phase === "no_feasible_plan") return null;
  if (p.status === "superseded" || p.status === "infeasible") return null;
  return p;
}

export function planById(run: Run, revision: number | undefined): Plan | null {
  if (revision === undefined) return null;
  return run.plans.find((p) => p.revision === revision) ?? null;
}

export function offerTimeText(o: Offer): string {
  const t = formatLocal(o.fulfillment.timeLocal);
  if (o.fulfillment.mode === "pickup_only") return `ready ${t}`;
  return `arrives ${t}`;
}

/** Wall-clock time of an ISO instant in the event timezone, with seconds. */
export function clockTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(11, 19);
  }
}

export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function minutesText(n: number): string {
  return `${n} min`;
}

/** Groups an offer serves, from its lines and fulfillment mode. */
export function offerCovers(o: Offer): CapabilityGroup[] {
  const set = new Set<CapabilityGroup>();
  for (const l of o.lines) {
    if (l.kind === "meal_vegetarian" || l.kind === "meal_standard") set.add("meals");
    else if (l.kind === "delivery_run") set.add("delivery");
    else set.add("drinks_consumables");
  }
  if (o.fulfillment.mode === "included_delivery" || o.fulfillment.mode === "courier") set.add("delivery");
  return GROUPS.filter((g) => set.has(g));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
