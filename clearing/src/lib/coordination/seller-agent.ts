/**
 * Seller side of BAND coordination, as a pure function so it is unit-testable.
 * `scripts/band-seller.mts` wires it to the BAND SDK run loop.
 *
 * The seller process holds exactly one merchant (with its private policy). It
 * answers only well-formed asks about its own offer, prices every revision
 * from its own catalog via `seller.respond`, and replies with a payload that
 * contains the outcome, a short reply line and the revised offer — never the
 * policy (floor, tiers, flexibility, round cap).
 */
import type { Merchant } from "../contracts";
import { formatCents } from "../money";
import { respond } from "../seller";
import { CLEARING_PROTOCOL, demandFromSummary, formatMessage, parseAsk, type ReplyPayload } from "./protocol";

export interface SellerInbound {
  content: string;
  senderId: string;
  senderName?: string | null;
}

export interface SellerOutbound {
  content: string;
  /** Who to @mention: the asking buyer agent. */
  mention: { id: string; name?: string };
  payload: ReplyPayload;
}

export interface SellerAgentOptions {
  /** When set, only asks sent by this agent id are answered. */
  buyerAgentId?: string;
}

/** Returns the reply to post, or null to ignore the message (no valid Clearing ask, or not for this seller). */
export function handleSellerMessage(merchant: Merchant, msg: SellerInbound, opts: SellerAgentOptions = {}): SellerOutbound | null {
  if (opts.buyerAgentId && msg.senderId !== opts.buyerAgentId) return null;
  const ask = parseAsk(msg.content);
  if (!ask || ask.offer.merchantId !== merchant.id) return null;
  const mention = { id: msg.senderId, ...(msg.senderName ? { name: msg.senderName } : {}) };
  const reply = (payload: ReplyPayload, line: string): SellerOutbound => ({
    content: formatMessage(`@${msg.senderName ?? "buyer"} ${line}`, payload),
    mention,
    payload,
  });

  if (ask.offer.id !== ask.offerId || ask.offer.revision !== ask.offerRevision || ask.offer.status !== "open") {
    const text = "That ask does not match my current open offer.";
    return reply({ clearing: CLEARING_PROTOCOL, askId: ask.askId, outcome: "declined", reply: text }, `${merchant.name} declined: ${text}`);
  }

  const out = respond(
    merchant,
    ask.offer,
    ask.lever,
    ask.round,
    { demand: demandFromSummary(ask.demandSummary), requestVersion: ask.offer.requestVersion, nowIso: ask.nowIso, reasoning: "local" },
    ask.topup ? { topup: ask.topup } : {},
  );
  if (out.outcome === "revised") {
    return reply(
      { clearing: CLEARING_PROTOCOL, askId: ask.askId, outcome: "revised", reply: out.reply, offer: out.offer },
      `${merchant.name} revised r${ask.offer.revision} → r${out.offer.revision}: ${formatCents(ask.offer.totalCents)} → ${formatCents(out.offer.totalCents)}. ${out.reply}`,
    );
  }
  return reply({ clearing: CLEARING_PROTOCOL, askId: ask.askId, outcome: "declined", reply: out.reply }, `${merchant.name} declined: ${out.reply}`);
}
