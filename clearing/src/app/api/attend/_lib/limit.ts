/**
 * Rate limit for public attendee submissions: 10 per minute per client.
 *
 * Reuses the shared in-memory token bucket from the agent front door (30 tokens,
 * refilling at 30 per minute) under its own key namespace, and charges 3 tokens
 * per submission, which yields 10 submissions per minute with a burst of 10.
 * Same caveat as the agent limiter: the client key is the forwarded-for header,
 * so this is a demo guard against loops, not a security boundary.
 */
import { ATTEND_RATE_LIMIT_PER_MINUTE } from "@/lib/attendee";
import { RATE_LIMIT_PER_MINUTE, clientKey, takeToken, type TokenResult } from "../../agent/_lib/ratelimit";

const COST = Math.max(1, Math.round(RATE_LIMIT_PER_MINUTE / ATTEND_RATE_LIMIT_PER_MINUTE));
const SECONDS_PER_TOKEN = 60 / RATE_LIMIT_PER_MINUTE;

/** Take one submission's worth of tokens for this client. `nowMs` is injectable for tests. */
export function takeAttendToken(request: Request, nowMs: number = Date.now()): TokenResult {
  const key = `attend:${clientKey(request)}`;
  for (let i = 0; i < COST; i++) {
    const t = takeToken(key, nowMs);
    // A refused request still spent what it took, so the retry needs a full submission's worth again.
    if (!t.ok) return { ok: false, retryAfterSeconds: t.retryAfterSeconds + Math.ceil((COST - 1) * SECONDS_PER_TOKEN) };
  }
  return { ok: true };
}

export function attendRateLimited(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: `Too many answers from this network: ${ATTEND_RATE_LIMIT_PER_MINUTE} per minute. Try again in ${retryAfterSeconds}s.`,
        details: { limitPerMinute: ATTEND_RATE_LIMIT_PER_MINUTE, retryAfterSeconds },
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds) } },
  );
}
