/**
 * Attendee opt-in (P1 group demand): pure helpers shared by the service, the
 * routes and the attendee page. No Node-only imports, so the client page can
 * use the view schema and the copy.
 *
 * Authority boundary: a link token grants exactly two things, reading the
 * public event summary below and submitting one anonymous answer per browser.
 * It never reaches the budget, plans, offers, orders, approvals or run id, and
 * it cannot change requirements: only the organizer applies the counts.
 */
import { z } from "zod";
import { AttendeeSubmitCommand, Id, IdempotencyKey, IsoDate, LocalTime, type AttendeeResponse, type AttendeeSummary, type Run } from "./contracts";

/** Shown on the attendee page and in docs. Interest is not an order. */
export const ATTENDEE_DISCLAIMER = "Your answer only helps the organizer plan quantities. It is not an order, a reservation, or a payment.";

/** Hard cap on distinct respondents per run (6 × 800 = 4,800 people stays under the 5,000 headcount ceiling). */
export const MAX_ATTENDEE_RESPONSES = 800;

/** Public submissions per minute per client on `POST /api/attend/[token]`. */
export const ATTEND_RATE_LIMIT_PER_MINUTE = 10;

/** 24 random bytes as 48 hex characters (192 bits). */
export const ATTENDEE_TOKEN_RE = /^[a-f0-9]{48}$/;

export function newAttendeeToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison for equal-length tokens. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Organizer command bodies (console routes)
// ---------------------------------------------------------------------------

/** `runId`, when sent, must be the current run: a stale tab or the /dev sample cannot act on the live run. */
export const AttendeeLinkCommand = z.object({ idempotencyKey: IdempotencyKey.optional(), runId: Id.optional() }).strict();
export type AttendeeLinkCommand = z.infer<typeof AttendeeLinkCommand>;

export const AttendeeApplyCommand = z.object({ idempotencyKey: IdempotencyKey, runId: Id.optional() }).strict();
export type AttendeeApplyCommand = z.infer<typeof AttendeeApplyCommand>;

/** Public submit body (the token comes from the URL). */
export const AttendeeSubmitBody = AttendeeSubmitCommand.omit({ token: true }).strict();

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function emptyAttendeeSummary(): AttendeeSummary {
  return { responses: 0, people: 0, vegetarian: 0, flexible: 0, appliedAt: null, appliedPeople: null };
}

/** Counts from all stored answers; keeps when the organizer last applied counts. */
export function summarizeAttendees(responses: readonly AttendeeResponse[], previous?: AttendeeSummary): AttendeeSummary {
  let people = 0;
  let vegetarian = 0;
  for (const r of responses) {
    people += r.partySize;
    if (r.preference === "vegetarian") vegetarian += r.partySize;
  }
  return {
    responses: responses.length,
    people,
    vegetarian,
    flexible: people - vegetarian,
    appliedAt: previous?.appliedAt ?? null,
    appliedPeople: previous?.appliedPeople ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public view (the only run data an attendee link can read)
// ---------------------------------------------------------------------------

export const AttendeePublicView = z
  .object({
    objective: z.string().max(200),
    eventDate: IsoDate,
    timezone: z.string().max(64),
    readyByLocal: LocalTime.nullable(),
    venueName: z.string().max(200).nullable(),
    summary: z.object({
      responses: z.number().int().min(0),
      people: z.number().int().min(0),
      vegetarian: z.number().int().min(0),
      flexible: z.number().int().min(0),
    }).strict(),
    enabled: z.boolean(),
  })
  .strict();
export type AttendeePublicView = z.infer<typeof AttendeePublicView>;

/** Currency amounts are budget data; strip them from free text before it reaches the public page. */
function withoutAmounts(text: string): string {
  return text.replace(/(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|eur|gbp)\b)/gi, "").replace(/\s{2,}/g, " ").trim();
}

export function attendeePublicView(run: Run): AttendeePublicView {
  const req = run.requirements;
  const s = run.attendeeSummary ?? emptyAttendeeSummary();
  return AttendeePublicView.parse({
    objective: withoutAmounts(req?.objective ?? "") || "Event",
    eventDate: req?.eventDate ?? run.request.eventDate,
    timezone: req?.timezone ?? run.request.timezone,
    readyByLocal: req?.readyByLocal ?? null,
    venueName: req?.venue.name ?? run.request.venueName ?? null,
    summary: { responses: s.responses, people: s.people, vegetarian: s.vegetarian, flexible: s.flexible },
    enabled: run.attendeeLink?.enabled === true,
  });
}
