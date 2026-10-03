/**
 * Tavily web discovery (optional). Real search results about possible suppliers are
 * shown as UNVERIFIED CANDIDATES with their source URL and retrieval time. A search
 * result is never a quote, inventory, dietary certification, or supplier consent,
 * and it can never become an executable offer. Documented request shape:
 * POST https://api.tavily.com/search with `Authorization: Bearer <key>` and
 * { query, search_depth, max_results }; results carry url/title/content/score only.
 */
import type { DiscoveryCandidate, DiscoveryProvider, DiscoveryResult } from "./types";

export interface TavilyOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

export function tavilyWebDiscovery(opts: TavilyOptions): DiscoveryProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? "https://api.tavily.com/search";
  let connected = false;
  let lastError: string | null = null;
  return {
    name: "Tavily web search",
    async discover(query, { topK }): Promise<DiscoveryResult> {
      const started = Date.now();
      const signal = AbortSignal.timeout(opts.timeoutMs ?? 5_000);
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ query: `${query} caterer OR beverage delivery OR courier`, search_depth: "basic", max_results: Math.min(Math.max(topK, 1), 10) }),
        signal,
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        connected = false;
        throw new Error(`Tavily search failed: ${lastError}`);
      }
      const body = (await res.json()) as { results?: TavilyResult[] };
      const retrievedAt = new Date().toISOString();
      const candidates: DiscoveryCandidate[] = (body.results ?? [])
        .filter((r) => typeof r.url === "string" && typeof r.title === "string")
        .slice(0, topK)
        .map((r, i) => ({
          id: `web:${i + 1}`,
          name: (r.title ?? "").slice(0, 120),
          score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : null,
          executable: false,
          note: `web result · ${r.url} · retrieved ${retrievedAt} · not a quote, availability, or consent`,
        }));
      connected = true;
      lastError = null;
      return { candidates, engine: "tavily", indexed: candidates.length, ms: Date.now() - started };
    },
    status() {
      if (connected) return { connected: true, note: "Tavily answered a search in this process; results are unverified web candidates" };
      return { connected: false, note: lastError ? `Tavily configured but the last call failed: ${lastError}` : "Tavily key present; unverified until the first successful search" };
    },
  };
}

/** Run the directory engine and, alongside it, web discovery; web results are appended, never executable. */
export function withWebDiscovery(primary: DiscoveryProvider, web: DiscoveryProvider): DiscoveryProvider {
  return {
    name: `${primary.name} + ${web.name}`,
    async discover(query, opts) {
      const [base, webResult] = await Promise.all([
        primary.discover(query, opts),
        web.discover(query, { topK: Math.min(opts.topK, 5), zone: opts.zone }).then(
          (r) => ({ ok: true as const, r }),
          (err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message.slice(0, 120) : "web discovery failed" }),
        ),
      ]);
      if (!webResult.ok) return { ...base, web: { engine: "tavily", count: 0, ms: 0, ok: false, reason: webResult.reason } };
      return {
        ...base,
        candidates: [...base.candidates, ...webResult.r.candidates.map((c) => ({ ...c, executable: false }))],
        web: { engine: "tavily", count: webResult.r.candidates.length, ms: webResult.r.ms, ok: true },
      };
    },
    status() {
      const p = primary.status();
      const w = web.status();
      return { connected: p.connected, note: `${p.note} · web: ${w.note}` };
    },
  };
}
