/**
 * Process-wide BAND evidence, kept dependency-free so `providers/status.ts`
 * can read it without loading the coordinator or the SDK.
 */
let live: { roomId: string; roundTrips: number } | null = null;

/** Buyer agent credentials present (presence only; values are never read into output). */
export function bandConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.BAND_BUYER_AGENT_ID && env.BAND_BUYER_API_KEY);
}

/** Non-null only after a seller reply arrived through a BAND room in this process. */
export function bandLiveVerified(): { roomId: string; roundTrips: number } | null {
  return live ? { ...live } : null;
}

export function recordBandRoundTrip(roomId: string): void {
  live = { roomId, roundTrips: (live?.roomId === roomId ? live.roundTrips : 0) + 1 };
}

/** Test hook: forget process-wide BAND evidence. */
export function resetBandLiveState(): void {
  live = null;
}
