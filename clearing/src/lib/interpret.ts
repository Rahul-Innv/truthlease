/**
 * Request interpretation (local rules).
 *
 * Turns the organizer's free text plus explicit form fields into structured
 * requirements, marking each field confirmed / assumed / missing. A live model
 * may replace the text parsing, but the server still owns validation, the
 * event date, timezone, venue and the simulated clock.
 */
import { DEMO_VENUE } from "./catalog";
import {
  Requirements,
  type ModelRequirementsOutput,
  type RequestInput,
  type RequirementField,
  type FieldStatus,
} from "./contracts";
import { parseDollarsToCents } from "./money";
import { parseLooseTime } from "./time";

export const DEFAULT_SETUP_BUFFER_MINUTES = 20;

export interface Extracted {
  objective: string;
  headcount: number | null;
  vegetarianMin: number | null;
  readyByLocal: string | null;
  budgetCents: number | null;
  wantsDrinks: boolean;
  wantsPlates: boolean;
  wantsUtensils: boolean;
  preferences: string[];
}

/** Deterministic text extraction. Treats the text purely as data. */
export function extractLocal(text: string): Extracted {
  const t = text.replace(/\s+/g, " ");
  const lower = t.toLowerCase();

  const headcountMatch =
    /(?:for|feed|feeding|serve|serving)\s+(\d{1,4})\s+(?:people|attendees|guests|hackers|folks|team)/i.exec(t) ??
    /(\d{1,4})\s+(?:people|attendees|guests|hackers|folks)/i.exec(t);
  const headcount = headcountMatch?.[1] ? Number(headcountMatch[1]) : null;

  const vegMatch =
    /(?:at least|minimum of|min\.?)\s+(\d{1,4})\s+(?:need|require|are|want)?\s*(?:vegetarian|veg\b)/i.exec(t) ??
    /(\d{1,4})\s+(?:need|require|are|want)?\s*(?:vegetarian|veg\b)/i.exec(t);
  const vegetarianMin = vegMatch?.[1] ? Number(vegMatch[1]) : /vegetarian/i.test(t) ? null : 0;

  const timeMatch = /(?:ready|set ?up|arrive|delivered|deliver|by)\s+(?:by\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i.exec(t);
  const readyByLocal = timeMatch?.[1] ? parseLooseTime(timeMatch[1]) : null;

  const budgetMatch = /(?:max(?:imum)?|budget|under|up to|no more than|cap(?:ped)? at)\s*(?:of\s*)?(\$\s?[\d,]+(?:\.\d{1,2})?)/i.exec(t) ?? /(\$\s?[\d,]+(?:\.\d{1,2})?)/.exec(t);
  const budgetCents = budgetMatch?.[1] ? parseDollarsToCents(budgetMatch[1]) : null;

  const wantsDrinks = /drink|beverage|water|soda/.test(lower);
  const wantsPlates = /plate/.test(lower);
  const wantsUtensils = /utensil|cutlery|fork|napkin/.test(lower);

  const preferences: string[] = [];
  if (/nonalcoholic|non-alcoholic|no alcohol/.test(lower)) preferences.push("Nonalcoholic drinks only");
  if (/vegan/.test(lower)) preferences.push("Vegan options mentioned (not modelled separately)");
  if (/gluten/.test(lower)) preferences.push("Gluten-free mentioned (not modelled separately)");

  const objective = /dinner/.test(lower)
    ? "Dinner"
    : /lunch/.test(lower)
      ? "Lunch"
      : /breakfast/.test(lower)
        ? "Breakfast"
        : "Catered gathering";

  return { objective, headcount, vegetarianMin, readyByLocal, budgetCents, wantsDrinks, wantsPlates, wantsUtensils, preferences };
}

export function fromModelOutput(o: ModelRequirementsOutput): Extracted {
  return {
    objective: o.objective.slice(0, 120) || "Catered gathering",
    headcount: o.headcount,
    vegetarianMin: o.vegetarianMin,
    readyByLocal: o.readyByLocal ? parseLooseTime(o.readyByLocal) : null,
    budgetCents: o.budgetCents,
    wantsDrinks: o.wantsDrinks,
    wantsPlates: o.wantsPlates,
    wantsUtensils: o.wantsUtensils,
    preferences: o.preferences.map((p) => p.slice(0, 120)),
  };
}

/** Combine extraction with the explicit form fields into validated Requirements. */
export function buildRequirements(input: RequestInput, ex: Extracted, interpretedBy: "local" | "live"): Requirements {
  const fieldStatus: Record<RequirementField, FieldStatus> = {
    objective: "confirmed",
    venue: input.venueName ? "confirmed" : "assumed",
    timezone: "confirmed",
    eventDate: "confirmed",
    readyBy: ex.readyByLocal ? "confirmed" : "missing",
    headcount: ex.headcount ? "confirmed" : "missing",
    vegetarianMin: ex.vegetarianMin === null ? "missing" : "confirmed",
    drinks: ex.wantsDrinks ? "confirmed" : "assumed",
    plates: ex.wantsPlates ? "confirmed" : "assumed",
    utensils: ex.wantsUtensils ? "confirmed" : "assumed",
    budget: ex.budgetCents !== null ? "confirmed" : "missing",
  };
  const assumptions: { field: RequirementField; note: string }[] = [];
  if (!input.venueName) assumptions.push({ field: "venue", note: `Using the fictional demo venue "${DEMO_VENUE.name}" in zone "${DEMO_VENUE.zone}".` });
  if (!ex.wantsDrinks) assumptions.push({ field: "drinks", note: "No drinks requested; none will be sourced." });
  if (!ex.wantsPlates) assumptions.push({ field: "plates", note: "No plates requested; none will be sourced." });
  if (!ex.wantsUtensils) assumptions.push({ field: "utensils", note: "No utensils requested; none will be sourced." });
  assumptions.push({ field: "readyBy", note: `A ${DEFAULT_SETUP_BUFFER_MINUTES}-minute setup buffer is applied before the ready-by time.` });

  const missing = (Object.keys(fieldStatus) as RequirementField[]).filter((k) => fieldStatus[k] === "missing");

  const headcount = ex.headcount ?? 1;
  const vegetarianMin = Math.min(ex.vegetarianMin ?? 0, headcount);

  return Requirements.parse({
    objective: ex.objective,
    venue: input.venueName ? { name: input.venueName, zone: DEMO_VENUE.zone, fictional: false } : DEMO_VENUE,
    timezone: input.timezone,
    eventDate: input.eventDate,
    nowLocal: input.nowLocal,
    readyByLocal: ex.readyByLocal ?? "18:30",
    setupBufferMinutes: DEFAULT_SETUP_BUFFER_MINUTES,
    headcount,
    vegetarianMin,
    items: { drinks: ex.wantsDrinks, plates: ex.wantsPlates, utensils: ex.wantsUtensils },
    preferences: ex.preferences,
    budgetCents: ex.budgetCents ?? 0,
    fieldStatus,
    assumptions,
    missing,
    interpretedBy,
  });
}

export function interpretLocal(input: RequestInput): Requirements {
  return buildRequirements(input, extractLocal(input.text), "local");
}
