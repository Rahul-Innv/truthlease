/**
 * Reasoning provider boundary. Exactly two components may be model-backed:
 * request interpretation and counteroffer suggestion (buyer lever choice,
 * seller response choice). Everything else is code.
 */
import type { Extracted } from "../interpret";
import type { NegotiationLever, Offer, ReasoningMode } from "../contracts";
import type { CounterRequest } from "../buyer";

export interface ProviderResult<T> {
  value: T;
  /** Which component produced the value after any fallback. */
  reasoning: ReasoningMode;
  /** Present when a live attempt failed and the local rule was used. */
  fallback?: { reason: string };
  callsUsed: number;
}

export interface ReasoningProvider {
  readonly mode: ReasoningMode;
  readonly provider: string;
  interpret(text: string, signal?: AbortSignal): Promise<ProviderResult<Extracted>>;
  /** Choose which of the code-derived candidate asks to send (may reorder/trim, never invent). */
  chooseAsks(candidates: CounterRequest[], context: { round: number }, signal?: AbortSignal): Promise<ProviderResult<CounterRequest[]>>;
  /** Choose a permitted seller response; code validates the result. */
  chooseSellerLever(offer: Offer, lever: NegotiationLever, signal?: AbortSignal): Promise<ProviderResult<NegotiationLever>>;
  /** Calls made so far in this process for the current run. */
  callsUsed(): number;
}
