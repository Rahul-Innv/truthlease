/**
 * BAND coordinator — the buyer side of a real multi-agent negotiation.
 *
 * One BAND chat room (created by the buyer agent, or reused from BAND_ROOM_ID)
 * holds the buyer agent and one agent per seller. For each ask the buyer posts
 * ONE message that @mentions that seller's agent, carrying a JSON ask. The
 * seller runs as its own process (`scripts/band-seller.mts`) with only its own
 * merchant policy, prices the revision and @mentions the buyer back.
 *
 * Nothing the room says is trusted: the reply must come from the mapped seller
 * agent, match the ask id, parse as the Offer contract, keep id/merchant/
 * requestVersion, advance the revision by exactly one, and reproduce the
 * totals the seller's policy allows (re-priced here from the private catalog).
 * Anything else is a decline with "reply failed validation". Timeouts and
 * transport errors are declines too, so the pipeline always continues.
 *
 * Transport facts (docs.band.ai, @band-ai/sdk 0.5.0): Agent API base
 * https://app.band.ai/api/v1/agent, header X-API-Key; POST /agent/chats,
 * GET|POST /agent/chats/{id}/participants, POST /agent/chats/{id}/messages
 * (requires mentions), GET /agent/chats/{id}/messages (unprocessed by default),
 * POST .../messages/{mid}/processing|processed; WebSocket channel
 * chat_room:{id} → message_created for messages that @mention the agent.
 * The real transport lives in `band-sdk.ts`; tests inject a fake.
 */
import { Offer, type Merchant } from "../contracts";
import { respond, type ConcessionResult } from "../seller";
import { bandConfigured, recordBandRoundTrip } from "./band-state";
import { localCoordinator } from "./local";
import { CLEARING_PROTOCOL, formatMessage, parseReply, summarizeDemand, type AskPayload } from "./protocol";
import type { CoordinatedResult, CoordinationInput, CoordinationTrace, Coordinator } from "./types";

export interface BandParticipant {
  id: string;
  name: string;
  type: string;
  handle?: string | null;
}

export interface BandMessage {
  id: string;
  content: string;
  senderId: string;
  senderName?: string | null;
}

export interface BandMention {
  id: string;
  handle?: string;
  name?: string;
}

/** The slice of the BAND Agent API the buyer needs. Injected so tests run without network. */
export interface BandTransport {
  createChat(): Promise<{ id: string }>;
  listParticipants(chatId: string): Promise<BandParticipant[]>;
  addParticipant(chatId: string, participantId: string): Promise<BandParticipant | null>;
  sendMessage(chatId: string, content: string, mentions: BandMention[]): Promise<{ id: string | null }>;
  /** Messages delivered to the buyer that it has not marked processed (oldest first). */
  listMessages(chatId: string): Promise<BandMessage[]>;
  /** Optional push delivery (WebSocket). Resolves to an unsubscribe function. */
  subscribe?(chatId: string, onMessage: (m: BandMessage) => void): Promise<() => void>;
  /** Optional: acknowledge a consumed message so it leaves the buyer's queue. */
  markProcessed?(chatId: string, messageId: string): Promise<void>;
}

export interface BandCoordinatorOptions {
  /** A transport, or a lazy factory (the SDK is only loaded on first use). */
  transport: BandTransport | (() => Promise<BandTransport>);
  buyerAgentId: string;
  /** merchantId → seller agent id. Unmapped merchants use the local coordinator. */
  sellerAgents: Record<string, string>;
  /** Reuse an existing room instead of creating one. */
  roomId?: string;
  /** Private catalog, used for the local fallback and the re-pricing check. */
  catalog: Merchant[];
  replyTimeoutMs?: number;
  pollMs?: number;
  newAskId?: () => string;
}

export const DEFAULT_REPLY_TIMEOUT_MS = 45_000;
export const DEFAULT_POLL_MS = 1_500;
export const TIMEOUT_REPLY = "BAND reply timed out";
export const VALIDATION_REPLY = "reply failed validation";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function sameLines(a: Offer, b: Offer): boolean {
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((l, i) => {
    const o = b.lines[i]!;
    return l.sku === o.sku && l.kind === o.kind && l.qty === o.qty && l.unitCents === o.unitCents && l.lineCents === o.lineCents;
  });
}

/**
 * Accept a seller's revised offer only if it is exactly what the seller's policy permits.
 * Returns the server-owned revision (recomputed here) or the reason it failed.
 */
export function verifySellerRevision(raw: unknown, input: CoordinationInput, merchant: Merchant): { ok: true; offer: Offer } | { ok: false; why: string } {
  const { offer: cur, ask, round, ctx } = input;
  const parsed = Offer.safeParse(raw);
  if (!parsed.success) return { ok: false, why: "offer does not match the Offer contract" };
  const o = parsed.data;
  if (o.id !== cur.id || o.merchantId !== cur.merchantId || o.requestVersion !== cur.requestVersion) return { ok: false, why: "offer identity changed" };
  if (o.revision !== cur.revision + 1) return { ok: false, why: `revision must be ${cur.revision + 1}` };
  const expected = respond(merchant, cur, ask.lever, round, ctx, ask.topup ? { topup: ask.topup } : {});
  if (expected.outcome !== "revised") return { ok: false, why: "policy does not permit a revision" };
  const e = expected.offer;
  const fees = (x: Offer) => x.fees.map((f) => f.cents).join(",");
  if (o.totalCents !== e.totalCents || !sameLines(o, e) || fees(o) !== fees(e) || o.deliveryCents !== e.deliveryCents) {
    return { ok: false, why: "prices differ from what policy allows" };
  }
  if (o.fulfillment.slotId !== e.fulfillment.slotId || o.fulfillment.timeLocal !== e.fulfillment.timeLocal || o.fulfillment.pickupByLocal !== e.fulfillment.pickupByLocal) {
    return { ok: false, why: "fulfillment window differs from what policy allows" };
  }
  // Server-owned copy: ids, revision, totals and timestamps come from code, never from the room.
  return { ok: true, offer: { ...e, provenance: { ...e.provenance, note: `${e.provenance.note} · via BAND`.slice(0, 200) } } };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

function abortableSleep(ms: number, signal: AbortSignal | undefined, wake: (fn: (() => void) | null) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      wake(null);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    wake(finish);
  });
}

function randomAskId(): string {
  return `ask_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function createBandCoordinator(opts: BandCoordinatorOptions): Coordinator {
  const local = localCoordinator(opts.catalog);
  const byId = new Map(opts.catalog.map((m) => [m.id, m]));
  const timeoutMs = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const pollMs = Math.max(1, opts.pollMs ?? DEFAULT_POLL_MS);
  const newAskId = opts.newAskId ?? randomAskId;
  const unmapped = new Set<string>();
  let transportP: Promise<BandTransport> | null = null;
  let roomP: Promise<string> | null = null;
  const participants = new Map<string, Promise<BandParticipant>>();
  const inbox: BandMessage[] = [];
  let wakeWaiter: (() => void) | null = null;
  let roundTrips = 0;
  let lastError: string | null = null;
  let roomId: string | null = opts.roomId ?? null;

  function transport(): Promise<BandTransport> {
    if (!transportP) {
      const t = opts.transport;
      transportP = typeof t === "function" ? t() : Promise.resolve(t);
      transportP.catch(() => (transportP = null));
    }
    return transportP;
  }

  function room(): Promise<string> {
    if (!roomP) {
      roomP = (async () => {
        const t = await transport();
        const id = opts.roomId ?? (await t.createChat()).id;
        roomId = id;
        if (t.subscribe) {
          try {
            await t.subscribe(id, (m) => {
              inbox.push(m);
              if (inbox.length > 200) inbox.shift();
              wakeWaiter?.();
            });
          } catch {
            // Push delivery is an optimisation; polling the messages endpoint still works.
          }
        }
        return id;
      })();
      roomP.catch(() => (roomP = null));
    }
    return roomP;
  }

  function participant(chatId: string, agentId: string): Promise<BandParticipant> {
    let p = participants.get(agentId);
    if (!p) {
      p = (async () => {
        const t = await transport();
        const present = (await t.listParticipants(chatId)).find((x) => x.id === agentId);
        if (present) return present;
        const added = await t.addParticipant(chatId, agentId);
        return added ?? { id: agentId, name: agentId, type: "Agent" };
      })();
      participants.set(agentId, p);
      p.catch(() => participants.delete(agentId));
    }
    return p;
  }

  async function ack(t: BandTransport, chatId: string, id: string): Promise<void> {
    try {
      await t.markProcessed?.(chatId, id);
    } catch {
      // Best effort: an unacknowledged reply only stays in the buyer's queue.
    }
  }

  async function awaitReply(t: BandTransport, chatId: string, sellerAgentId: string, askId: string, signal?: AbortSignal): Promise<BandMessage & { payload: NonNullable<ReturnType<typeof parseReply>> } | null> {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set<string>();
    const scan = async (msgs: BandMessage[]) => {
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const payload = parseReply(m.content);
        if (!payload) continue;
        // Only the mapped seller agent may answer this ask; stale replies are acknowledged and dropped.
        if (payload.askId === askId && m.senderId === sellerAgentId) return { ...m, payload };
        if (payload.askId !== askId) await ack(t, chatId, m.id);
      }
      return null;
    };
    while (!signal?.aborted) {
      const pushed = await scan(inbox.splice(0, inbox.length));
      if (pushed) return pushed;
      const polled = await scan(await t.listMessages(chatId));
      if (polled) return polled;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await abortableSleep(Math.min(pollMs, left), signal, (fn) => (wakeWaiter = fn));
    }
    return null;
  }

  async function viaBand(input: CoordinationInput, merchant: Merchant, sellerAgentId: string): Promise<CoordinatedResult> {
    const trace: CoordinationTrace = { transport: "band" };
    if (roomId) trace.roomId = roomId;
    try {
      const t = await transport();
      const chatId = await room();
      trace.roomId = chatId;
      const seller = await participant(chatId, sellerAgentId);
      const askId = newAskId();
      trace.askId = askId;
      const payload: AskPayload = {
        clearing: CLEARING_PROTOCOL,
        askId,
        offerId: input.offer.id,
        offerRevision: input.offer.revision,
        lever: input.ask.lever,
        ...(input.ask.topup ? { topup: input.ask.topup } : {}),
        round: input.round,
        demandSummary: summarizeDemand(input.ctx.demand),
        nowIso: input.ctx.nowIso,
        offer: input.offer,
      };
      const handle = seller.handle || seller.name || sellerAgentId;
      const mention: BandMention = { id: sellerAgentId, ...(seller.handle ? { handle: seller.handle } : {}), ...(seller.name ? { name: seller.name } : {}) };
      const sent = await t.sendMessage(chatId, formatMessage(`@${handle} Round ${input.round} · ${input.ask.lever}: ${input.ask.ask}`, payload), [mention]);
      if (sent.id) trace.askMessageId = sent.id;
      const reply = await awaitReply(t, chatId, sellerAgentId, askId, input.signal);
      if (!reply) {
        trace.note = input.signal?.aborted ? "aborted" : `no reply within ${timeoutMs} ms`;
        return { outcome: "declined", reply: TIMEOUT_REPLY, trace };
      }
      trace.replyMessageId = reply.id;
      await ack(t, chatId, reply.id);
      roundTrips += 1;
      recordBandRoundTrip(chatId);
      lastError = null;
      if (reply.payload.outcome === "declined") return { outcome: "declined", reply: reply.payload.reply || "Declined.", trace };
      const verdict = verifySellerRevision(reply.payload.offer, input, merchant);
      if (!verdict.ok) {
        trace.note = verdict.why;
        return { outcome: "declined", reply: `${VALIDATION_REPLY}: ${verdict.why}`, trace };
      }
      return { outcome: "revised", offer: verdict.offer, reply: reply.payload.reply, trace } satisfies ConcessionResult & { trace: CoordinationTrace };
    } catch (err) {
      // Never echo transport error text (it may carry request details); the class name is enough.
      lastError = err instanceof Error ? err.name : "Error";
      trace.note = `transport error (${lastError})`;
      return { outcome: "declined", reply: `${TIMEOUT_REPLY} (transport error)`, trace };
    }
  }

  return {
    name: "band",
    async requestConcession(input: CoordinationInput): Promise<CoordinatedResult> {
      const merchant = byId.get(input.ask.merchantId);
      const sellerAgentId = opts.sellerAgents[input.ask.merchantId];
      if (!merchant || !sellerAgentId) {
        unmapped.add(input.ask.merchantId);
        const out = await local.requestConcession(input);
        return { ...out, trace: { transport: "local", note: "no BAND seller agent mapped for this merchant" } };
      }
      return viaBand(input, merchant, sellerAgentId);
    },
    status() {
      const fallback = unmapped.size ? `; local fallback for ${[...unmapped].sort().join(", ")}` : "";
      if (roundTrips > 0 && roomId) return { connected: true, note: `Live-verified: room ${roomId}, ${roundTrips} round trips${fallback}`.slice(0, 200) };
      const err = lastError ? `; last error: ${lastError}` : "";
      return { connected: false, note: `Configured: negotiation runs through a BAND room (buyer agent + seller agent processes); unverified until a round trip completes${fallback}${err}`.slice(0, 200) };
    },
  };
}

/** Parse BAND_SELLER_AGENTS (JSON map merchantId → agent id). Invalid input yields an empty map. */
export function parseSellerAgents(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0));
  } catch {
    return {};
  }
}

/** BAND coordinator from env, or null when the buyer agent credentials are absent. Keys are never logged. */
export function bandCoordinatorFromEnv(env: NodeJS.ProcessEnv, catalog: Merchant[]): Coordinator | null {
  if (!bandConfigured(env)) return null;
  const agentId = env.BAND_BUYER_AGENT_ID!;
  const apiKey = env.BAND_BUYER_API_KEY!;
  const sellerAgents = parseSellerAgents(env.BAND_SELLER_AGENTS);
  if (env.BAND_SELLER_AGENTS && Object.keys(sellerAgents).length === 0) console.error("[clearing] BAND_SELLER_AGENTS is not a JSON object of merchantId → agent id; every merchant uses local coordination.");
  return createBandCoordinator({
    transport: async () => (await import("./band-sdk")).sdkBandTransport({ agentId, apiKey, ...(env.BAND_WS_URL ? { wsUrl: env.BAND_WS_URL } : {}), ...(env.BAND_REST_URL ? { restUrl: env.BAND_REST_URL } : {}) }),
    buyerAgentId: agentId,
    sellerAgents,
    ...(env.BAND_ROOM_ID ? { roomId: env.BAND_ROOM_ID } : {}),
    catalog,
    replyTimeoutMs: Number(env.BAND_REPLY_TIMEOUT_MS ?? DEFAULT_REPLY_TIMEOUT_MS) || DEFAULT_REPLY_TIMEOUT_MS,
  });
}
