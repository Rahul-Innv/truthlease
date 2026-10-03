/**
 * Simulated money movement. Nothing here touches a real payment system.
 *
 * Budget exposure = committed (active simulated orders) + retained (nonrefundable
 * portions of cancelled orders) + pending refunds (not yet settled). Pending
 * refunds never restore spendable budget until they settle.
 */
import type { CancellationTerms, LedgerEntry, SimOrder } from "./contracts";
import { pctOf } from "./money";

export interface Exposure {
  committedCents: number;
  retainedCents: number;
  pendingRefundCents: number;
  /** Everything the budget is currently exposed to. */
  exposureCents: number;
}

export function isActiveOrder(o: SimOrder): boolean {
  return o.status === "simulated_placed" || o.status === "simulated_confirmed";
}

export function computeExposure(orders: SimOrder[], ledger: LedgerEntry[]): Exposure {
  const committedCents = orders.filter(isActiveOrder).reduce((s, o) => s + o.amountCents, 0);
  const retainedCents = ledger.filter((e) => e.kind === "retained").reduce((s, e) => s + e.cents, 0);
  const pendingRefundCents = ledger.filter((e) => e.kind === "refund_pending").reduce((s, e) => s + e.cents, 0);
  return { committedCents, retainedCents, pendingRefundCents, exposureCents: committedCents + retainedCents + pendingRefundCents };
}

/** Cost of cancelling an order under the merchant's terms: what stays exposed. */
export function cancellationExposure(amountCents: number, terms: CancellationTerms): { retainedCents: number; refundCents: number; refundStatus: "settled" | "pending" | "none" } {
  const refundCents = pctOf(amountCents, terms.refundablePct);
  const retainedCents = amountCents - refundCents;
  const refundStatus = refundCents === 0 ? "none" : terms.settlement === "immediate" ? "settled" : "pending";
  return { retainedCents, refundCents, refundStatus };
}

/** Exposure that a cancellation leaves behind (retained + pending refund). */
export function sunkOnCancel(amountCents: number, terms: CancellationTerms): number {
  const c = cancellationExposure(amountCents, terms);
  return c.retainedCents + (c.refundStatus === "pending" ? c.refundCents : 0);
}
