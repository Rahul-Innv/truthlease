/**
 * Coordination boundary: how a buyer's concession request reaches a seller and
 * how the seller's answer comes back. The service decides *what* to ask (buyer
 * rules or a live model's lever choice); a Coordinator only carries the ask to
 * the seller and returns a validated ConcessionResult.
 *
 * - `local.ts`: in-process call to `seller.respond` (the default).
 * - `band.ts`: one BAND chat room; the buyer agent @mentions a seller agent that
 *   runs as its own process (`scripts/band-seller.mts`) and replies in the room.
 */
import type { CounterRequest } from "../buyer";
import type { Offer } from "../contracts";
import type { ConcessionResult, QuoteContext } from "../seller";

/** The ask as planned by the buyer (lever already resolved by the provider). */
export type CoordinationAsk = Pick<CounterRequest, "offerId" | "merchantId" | "lever" | "ask" | "topup">;

export interface CoordinationInput {
  ask: CoordinationAsk;
  /** The seller's current open revision of the offer. */
  offer: Offer;
  round: number;
  /** Seller quote context (demand slice, request version, clock, reasoning label). */
  ctx: QuoteContext;
  signal?: AbortSignal;
}

/** Evidence of how an answer travelled. Recorded in the negotiation event payload. */
export interface CoordinationTrace {
  transport: "local" | "band";
  roomId?: string;
  askId?: string;
  askMessageId?: string;
  replyMessageId?: string;
  /** Why BAND was not used, or why its reply was not accepted. */
  note?: string;
}

export type CoordinatedResult = ConcessionResult & { trace?: CoordinationTrace };

export interface Coordinator {
  readonly name: string;
  requestConcession(input: CoordinationInput): Promise<CoordinatedResult>;
  status(): { connected: boolean; note: string };
}
