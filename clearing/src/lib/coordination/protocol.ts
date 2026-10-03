/**
 * Wire protocol for Clearing negotiation over a BAND chat room.
 *
 * Every message is a short human-readable line (so the room reads well in the
 * BAND console) followed by one fenced JSON block. Room text is untrusted data:
 * both sides parse the block against these schemas and ignore anything else.
 *
 * The buyer's budget and other sellers' offers never appear in an ask; the
 * seller's private policy never appears in a reply.
 */
import { z } from "zod";
import { Id, NegotiationLever, Offer } from "../contracts";
import type { Demand } from "../solver";

export const CLEARING_PROTOCOL = 1 as const;

/** The slice of demand a seller needs to answer a lever (no budget, no other suppliers). */
export const DemandSummary = z.object({
  headcount: z.number().int().min(1).max(5_000),
  vegetarianMin: z.number().int().min(0).max(5_000),
  zone: z.string().max(80),
  nowMin: z.number().int().min(0).max(24 * 60),
});
export type DemandSummary = z.infer<typeof DemandSummary>;

const AskId = z.string().regex(/^ask_[A-Za-z0-9_-]{6,64}$/);

export const AskPayload = z.object({
  clearing: z.literal(CLEARING_PROTOCOL),
  askId: AskId,
  offerId: Id,
  offerRevision: z.number().int().min(1),
  lever: NegotiationLever,
  topup: z.object({ vegetarian: z.number().int().min(0).max(5_000), standard: z.number().int().min(0).max(5_000) }).optional(),
  round: z.number().int().min(1).max(2),
  demandSummary: DemandSummary,
  /** Clock for the revision's createdAt/expiresAt, so both sides price the same revision. */
  nowIso: z.string().datetime(),
  /** The seller's own current revision (its own quote; nothing private to the buyer). */
  offer: Offer,
});
export type AskPayload = z.infer<typeof AskPayload>;

export const ReplyPayload = z.object({
  clearing: z.literal(CLEARING_PROTOCOL),
  askId: AskId,
  outcome: z.enum(["revised", "declined"]),
  reply: z.string().max(200),
  /** Validated separately by the buyer against the Offer contract and the re-pricing check. */
  offer: z.unknown().optional(),
});
export type ReplyPayload = z.infer<typeof ReplyPayload>;

export function summarizeDemand(d: Demand): DemandSummary {
  return { headcount: d.headcount, vegetarianMin: d.vegetarianMin, zone: d.zone, nowMin: d.nowMin };
}

/** Rebuild the minimal Demand `seller.respond` reads. Budget and timing targets are not sent and are unused by respond(). */
export function demandFromSummary(s: DemandSummary): Demand {
  return {
    headcount: s.headcount,
    vegetarianMin: s.vegetarianMin,
    zone: s.zone,
    nowMin: s.nowMin,
    required: { meal_vegetarian: 0, meal_standard: 0, drink_serving: 0, plate: 0, utensil_set: 0, delivery_run: 0 },
    readyByMin: 0,
    latestArrivalMin: 0,
    budgetCents: 0,
  };
}

/** A human line plus one fenced JSON block. */
export function formatMessage(line: string, payload: object): string {
  return `${line.replace(/```/g, "'''").slice(0, 300)}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

/** Extract the first fenced JSON block (or, failing that, the outermost {...}) and parse it. Never throws. */
export function extractJsonBlock(content: string): unknown {
  if (typeof content !== "string" || content.length > 64_000) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const candidate = fenced?.[1] ?? (() => {
    const a = content.indexOf("{");
    const b = content.lastIndexOf("}");
    return a >= 0 && b > a ? content.slice(a, b + 1) : null;
  })();
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

export function parseAsk(content: string): AskPayload | null {
  const r = AskPayload.safeParse(extractJsonBlock(content));
  return r.success ? r.data : null;
}

export function parseReply(content: string): ReplyPayload | null {
  const r = ReplyPayload.safeParse(extractJsonBlock(content));
  return r.success ? r.data : null;
}
