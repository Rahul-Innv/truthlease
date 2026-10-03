/**
 * Deterministic keyword discovery. No network, no model, no randomness.
 *
 * Tokenise the query and every directory description, weight each shared token
 * by how rare it is in the directory (IDF), and add a fixed bonus when the
 * entry serves the requested zone. Entries that share no token with the query
 * are dropped. The ordering is the only output: `score` is always `null`,
 * because a keyword overlap sum is not a calibrated relevance score and must
 * not be shown as one.
 */
import { DIRECTORY, candidateNote, type DirectoryEntry } from "./directory";
import type { DiscoveryProvider, DiscoveryResult } from "./types";

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "are", "have", "has", "all", "any", "our", "your", "from", "into", "out", "per", "can", "need", "needs", "must", "will", "also",
  "serve", "zone", "include", "including", "included", "event", "attendee", "guest", "people", "least", "rest", "flexible", "ready", "maximum", "budget", "fee", "only", "item",
]);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Lowercase alphanumeric tokens, light plural stemming, stop words and 1-2 letter tokens removed. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const t = stem(raw);
    if (t.length >= 3 && !STOP.has(t) && !STOP.has(raw)) out.push(t);
  }
  return out;
}

const ZONE_BONUS = 2;

function buildIndex(entries: DirectoryEntry[]) {
  const docs = entries.map((e) => ({ entry: e, tokens: new Set(tokenize(`${e.name} ${e.text}`)) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + docs.length / (df.get(t) ?? 1));
  return { docs, idf };
}

export function localDiscovery(entries: DirectoryEntry[] = DIRECTORY): DiscoveryProvider {
  const { docs, idf } = buildIndex(entries);
  return {
    name: "local-keyword",
    async discover(query, opts): Promise<DiscoveryResult> {
      const started = performance.now();
      const zone = opts.zone.toLowerCase();
      // The zone only contributes through its bonus: a shared zone word alone is not a topical match.
      const zoneTokens = new Set(tokenize(zone));
      const q = [...new Set(tokenize(query))].filter((t) => !zoneTokens.has(t));
      const ranked = docs
        .map((d, order) => {
          const overlap = q.reduce((sum, t) => sum + (d.tokens.has(t) ? idf(t) : 0), 0);
          const zoneBonus = d.entry.metadata.zones.split(",").includes(zone) ? ZONE_BONUS : 0;
          return { d, order, overlap, total: overlap + zoneBonus };
        })
        .filter((r) => r.overlap > 0)
        // Highest total first; ties keep directory order, so the result is fully deterministic.
        .sort((a, b) => b.total - a.total || a.order - b.order)
        .slice(0, Math.max(0, opts.topK));
      return {
        candidates: ranked.map((r) => ({ id: r.d.entry.id, name: r.d.entry.name, score: null, executable: r.d.entry.executable, note: candidateNote(r.d.entry) })),
        engine: "local-keyword",
        indexed: docs.length,
        ms: Math.round((performance.now() - started) * 100) / 100,
      };
    },
    status() {
      return { connected: true, note: "Local deterministic keyword matcher over the fictional directory; no scores are produced." };
    },
  };
}
