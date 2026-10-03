/**
 * Moss (https://moss.dev) semantic discovery over the fictional supplier directory.
 *
 * Server-side only: the project key never reaches the browser. API used, from
 * node_modules/@moss-dev/moss/dist/moss.d.ts (v1.7.x):
 *   new MossClient(projectId, projectKey)
 *   client.createIndex(indexName, docs: DocumentInfo[]): Promise<MutationResult>   (throws if the index exists)
 *   client.loadIndex(indexName): Promise<string>                                   (downloads the index; queries then run in memory)
 *   client.query(indexName, text, { topK, alpha }): Promise<SearchResult>          (docs: { id, text, score, metadata? }[])
 *
 * Results are UNVERIFIED CANDIDATES. Whatever Moss returns is untrusted data:
 * ids are looked up in the local directory, and names, the executable flag and
 * the note come only from that local entry. Unknown ids are dropped. A Moss
 * hit can never make a supplier executable.
 */
import { DIRECTORY, candidateNote, getDirectoryEntry, type DirectoryEntry } from "./directory";
import { MOSS_INDEX_NAME, resetMossProcessStatus, setMossProcessStatus, type DiscoveryCandidate, type DiscoveryProvider, type DiscoveryResult } from "./types";

export { MOSS_INDEX_NAME, resetMossProcessStatus };
/** Hybrid fusion weight (0 = keyword only, 1 = semantic only). */
export const MOSS_ALPHA = 0.6;

/** The slice of MossClient this adapter uses; the real client satisfies it structurally. */
export interface MossLike {
  createIndex(indexName: string, docs: Array<{ id: string; text: string; metadata?: Record<string, string> }>): Promise<unknown>;
  loadIndex(indexName: string): Promise<unknown>;
  query(
    indexName: string,
    query: string,
    options?: { topK?: number; alpha?: number },
  ): Promise<{ docs: Array<{ id: string; text?: string; score: number; metadata?: Record<string, string> }> }>;
}

export interface MossProviderOptions {
  /** A client, or a lazy factory (used so the native SDK is only loaded when needed). */
  client: MossLike | (() => Promise<MossLike>);
  indexName?: string;
  directory?: DirectoryEntry[];
  alpha?: number;
  /** Delay before the single retry of index preparation. 0 in tests. */
  retryDelayMs?: number;
  /** Record success/failure in the process-wide status read by `discoveryStatus()`. */
  recordProcessStatus?: boolean;
}

export interface MossProvider extends DiscoveryProvider {
  /** Start index preparation in the background (create + load) so the first run is not slow. Never throws. */
  warm(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
const isAlreadyExists = (e: unknown) => /already exist|exists/i.test(e instanceof Error ? e.message : String(e));

/** Load the real SDK lazily. The `ignore` comments keep the bundler from trying to bundle its native addon. */
export async function createMossClient(projectId: string, projectKey: string): Promise<MossLike> {
  const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@moss-dev/moss");
  return new mod.MossClient(projectId, projectKey);
}

export function mossProvider(opts: MossProviderOptions): MossProvider {
  const indexName = opts.indexName ?? MOSS_INDEX_NAME;
  const directory = opts.directory ?? DIRECTORY;
  const alpha = opts.alpha ?? MOSS_ALPHA;
  const retryDelayMs = opts.retryDelayMs ?? 400;
  let clientPromise: Promise<MossLike> | null = null;
  let ready: Promise<MossLike> | null = null;
  let created = false;
  let connected = false;
  let lastError: string | null = null;

  const getClient = () => {
    clientPromise ??= typeof opts.client === "function" ? opts.client() : Promise.resolve(opts.client);
    return clientPromise;
  };

  async function prepareOnce(): Promise<MossLike> {
    const client = await getClient();
    if (!created) {
      try {
        await client.createIndex(
          indexName,
          directory.map((e) => ({ id: e.id, text: e.text, metadata: e.metadata })),
        );
      } catch (err) {
        // An index from an earlier process already exists: reuse it.
        if (!isAlreadyExists(err)) throw err;
      }
      created = true;
    }
    await client.loadIndex(indexName);
    return client;
  }

  /** Create (once per process) and load the index. One retry; a failed preparation is not cached. */
  function prepare(): Promise<MossLike> {
    if (!ready) {
      const attempt = (async () => {
        try {
          return await prepareOnce();
        } catch {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          return await prepareOnce();
        }
      })();
      ready = attempt;
      attempt.catch(() => {
        if (ready === attempt) ready = null;
      });
    }
    return ready;
  }

  const record = (ok: boolean, error: string | null) => {
    connected = ok;
    lastError = error;
    if (opts.recordProcessStatus) setMossProcessStatus({ ok, indexed: directory.length, lastError: error });
  };

  return {
    name: "moss",
    async warm() {
      try {
        await prepare();
      } catch (err) {
        lastError = errText(err);
        if (opts.recordProcessStatus) setMossProcessStatus({ ok: false, indexed: directory.length, lastError });
      }
    },
    async discover(query, o): Promise<DiscoveryResult> {
      const started = performance.now();
      try {
        const client = await prepare();
        const res = await client.query(indexName, query, { topK: o.topK, alpha });
        const seen = new Set<string>();
        const candidates: DiscoveryCandidate[] = [];
        for (const doc of res.docs ?? []) {
          const entry = getDirectoryEntry(String(doc.id));
          if (!entry || seen.has(entry.id)) continue;
          seen.add(entry.id);
          candidates.push({
            id: entry.id,
            name: entry.name,
            score: typeof doc.score === "number" && Number.isFinite(doc.score) ? doc.score : null,
            executable: entry.executable,
            note: candidateNote(entry),
          });
          if (candidates.length >= o.topK) break;
        }
        record(true, null);
        return { candidates, engine: "moss", indexed: directory.length, ms: Math.round(performance.now() - started) };
      } catch (err) {
        record(false, errText(err));
        throw err;
      }
    },
    status() {
      if (connected) return { connected: true, note: `Moss index "${indexName}" answered a query in this process (${directory.length} documents)` };
      return {
        connected: false,
        note: lastError ? `Moss configured but the last attempt failed: ${lastError}` : "Moss credentials present; unverified until the first successful query",
      };
    },
  };
}
