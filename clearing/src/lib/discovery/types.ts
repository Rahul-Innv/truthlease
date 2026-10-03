/**
 * Supplier discovery contract.
 *
 * Discovery answers "which suppliers might exist for this request?". Its results
 * are UNVERIFIED CANDIDATES for display. They are never offers: only the demo
 * catalog's merchants can quote, be negotiated with, or be cleared. A candidate
 * is `executable` only when the local directory (not the search engine) says
 * the id belongs to the executable demo catalog.
 */

export type DiscoveryEngine = "moss" | "local-keyword";

/** Name of the Moss index that holds the supplier directory. */
export const MOSS_INDEX_NAME = "clearing-suppliers";

// Process-wide Moss evidence, set only by a real successful (or failed) query. Kept here, not in
// moss.ts, so status helpers can read it without importing the Moss adapter or the directory.
export interface MossProcessStatus {
  ok: boolean;
  indexed: number;
  lastError: string | null;
}
let mossStatus: MossProcessStatus | null = null;

export function mossProcessStatus(): MossProcessStatus | null {
  return mossStatus ? { ...mossStatus } : null;
}

export function setMossProcessStatus(next: MossProcessStatus): void {
  mossStatus = { ...next };
}

export function resetMossProcessStatus(): void {
  mossStatus = null;
}

export interface DiscoveryCandidate {
  id: string;
  name: string;
  /** Retrieval score from the engine. `null` when the engine produced none (never fabricated). */
  score: number | null;
  /** True only for a merchant that exists in the executable demo catalog. */
  executable: boolean;
  note: string;
}

export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  engine: DiscoveryEngine;
  /** Number of directory entries the engine searched. */
  indexed: number;
  ms: number;
}

export interface DiscoveryProvider {
  name: string;
  discover(query: string, opts: { topK: number; zone: string }): Promise<DiscoveryResult>;
  status(): { connected: boolean; note: string };
}

// ---------------------------------------------------------------------------
// Reading the journaled discovery event (browser-safe: no server imports)
// ---------------------------------------------------------------------------

export interface DiscoveryView {
  /** False when discovery failed and the market opened without candidates. */
  ok: boolean;
  engine: DiscoveryEngine | null;
  indexed: number;
  ms: number;
  candidates: DiscoveryCandidate[];
  reason: string | null;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * The newest discovery event in a run's history (`model.call` / `model.fallback` with
 * component "discovery"), parsed defensively because event payloads are plain JSON.
 */
export function readDiscoveryEvent(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): DiscoveryView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.type !== "model.call" && e.type !== "model.fallback") || e.payload.component !== "discovery") continue;
    if (e.type === "model.fallback") {
      return { ok: false, engine: null, indexed: 0, ms: 0, candidates: [], reason: typeof e.payload.reason === "string" ? e.payload.reason : "unavailable" };
    }
    const raw = Array.isArray(e.payload.candidates) ? e.payload.candidates : [];
    const candidates: DiscoveryCandidate[] = [];
    for (const c of raw) {
      if (!c || typeof c !== "object") continue;
      const r = c as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.name !== "string") continue;
      candidates.push({ id: r.id, name: r.name, score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : null, executable: r.executable === true, note: typeof r.note === "string" ? r.note : "" });
    }
    const engine = e.payload.engine === "moss" || e.payload.engine === "local-keyword" ? e.payload.engine : null;
    return { ok: true, engine, indexed: num(e.payload.indexed), ms: num(e.payload.ms), candidates, reason: null };
  }
  return null;
}
