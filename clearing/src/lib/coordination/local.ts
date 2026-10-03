/**
 * Local coordinator: the seller answers in-process from the private catalog.
 * Behaviour is identical to calling `seller.respond` directly.
 */
import type { Merchant } from "../contracts";
import { respond } from "../seller";
import type { CoordinatedResult, CoordinationInput, Coordinator } from "./types";

export function localCoordinator(catalog: Merchant[]): Coordinator {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  return {
    name: "local",
    async requestConcession({ ask, offer, round, ctx }: CoordinationInput): Promise<CoordinatedResult> {
      const m = byId.get(ask.merchantId);
      if (!m) return { outcome: "declined", reply: "Unknown supplier.", trace: { transport: "local" } };
      const out = respond(m, offer, ask.lever, round, ctx, ask.topup ? { topup: ask.topup } : {});
      return { ...out, trace: { transport: "local" } };
    },
    status: () => ({ connected: true, note: "In-process seller responses (local transport)" }),
  };
}
