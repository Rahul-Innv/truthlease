/**
 * In-memory token bucket for the agent front door (demo only).
 *
 * 30 requests per minute per client: the bucket holds 30 tokens and refills
 * continuously at 0.5 tokens per second. The client key is the first
 * `x-forwarded-for` entry, or "local" when the header is absent. That header is
 * client-controlled unless a trusted proxy sets it, so this is a demo guard
 * against runaway agent loops, not a security boundary; the bucket map is
 * capped so rotating the header cannot grow memory without bound.
 *
 * State lives on globalThis so dev HMR and separately bundled route modules
 * share one set of buckets.
 */

export const RATE_LIMIT_PER_MINUTE = 30;
const REFILL_PER_MS = RATE_LIMIT_PER_MINUTE / 60_000;
const MAX_BUCKETS = 5_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

function buckets(): Map<string, Bucket> {
  const g = globalThis as typeof globalThis & { __clearingAgentBuckets?: Map<string, Bucket> };
  if (!g.__clearingAgentBuckets) g.__clearingAgentBuckets = new Map();
  return g.__clearingAgentBuckets;
}

/** Test hook: forget every bucket. */
export function resetRateLimit(): void {
  buckets().clear();
}

export function clientKey(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : "local";
}

export type TokenResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Take one token for `key`. `nowMs` is injectable for tests. */
export function takeToken(key: string, nowMs: number = Date.now()): TokenResult {
  const map = buckets();
  let bucket = map.get(key);
  if (!bucket) {
    if (map.size >= MAX_BUCKETS) prune(map, nowMs);
    bucket = { tokens: RATE_LIMIT_PER_MINUTE, updatedAt: nowMs };
    map.set(key, bucket);
  } else {
    const elapsed = Math.max(0, nowMs - bucket.updatedAt);
    bucket.tokens = Math.min(RATE_LIMIT_PER_MINUTE, bucket.tokens + elapsed * REFILL_PER_MS);
    bucket.updatedAt = nowMs;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true };
  }
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / REFILL_PER_MS / 1000)) };
}

/** Drop buckets that have refilled completely; if that is not enough, drop the oldest entries. */
function prune(map: Map<string, Bucket>, nowMs: number): void {
  for (const [k, b] of map) {
    if (b.tokens + (nowMs - b.updatedAt) * REFILL_PER_MS >= RATE_LIMIT_PER_MINUTE) map.delete(k);
  }
  for (const k of map.keys()) {
    if (map.size < MAX_BUCKETS) break;
    map.delete(k);
  }
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: `Rate limit exceeded: ${RATE_LIMIT_PER_MINUTE} requests per minute. Retry in ${retryAfterSeconds}s.`,
        details: { limitPerMinute: RATE_LIMIT_PER_MINUTE, retryAfterSeconds },
      },
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds) },
    },
  );
}

/** Run `fn` only when the caller has a token; otherwise answer 429 with Retry-After. */
export async function withRateLimit(request: Request, fn: () => Promise<Response>): Promise<Response> {
  const t = takeToken(clientKey(request));
  if (!t.ok) return rateLimitedResponse(t.retryAfterSeconds);
  return fn();
}
