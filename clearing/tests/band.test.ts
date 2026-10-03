/**
 * BAND coordination, offline: a FAKE BandTransport stands in for the BAND Agent
 * API (room, participants, @mention routing, unprocessed-message queue, push).
 * Seller agents in the fake run the real seller-side handler
 * (`coordination/seller-agent.ts`) — the same code `scripts/band-seller.mts` runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG } from "../src/lib/catalog";
import type { Merchant, Offer, RunEvent } from "../src/lib/contracts";
import { createBandCoordinator, parseSellerAgents, bandCoordinatorFromEnv, type BandMention, type BandMessage, type BandParticipant, type BandTransport } from "../src/lib/coordination/band";
import { bandLiveVerified, resetBandLiveState } from "../src/lib/coordination/band-state";
import { localCoordinator } from "../src/lib/coordination/local";
import { formatMessage, parseAsk, parseReply } from "../src/lib/coordination/protocol";
import { handleSellerMessage } from "../src/lib/coordination/seller-agent";
import type { CoordinationInput, Coordinator } from "../src/lib/coordination/types";
import { EXPECTED, fixedClock } from "../src/lib/fixtures";
import { integrationStatus } from "../src/lib/providers/status";
import { localProvider } from "../src/lib/providers/local";
import { respond } from "../src/lib/seller";
import { createService } from "../src/lib/service";
import { deriveDemand } from "../src/lib/solver";
import { openStore, type Store } from "../src/lib/store";
import { catalogMerchant, presetRequirements, qctxFor, quoteOffer } from "./helpers";

const BUYER = "agent-buyer-0001";
const agentFor = (merchantId: string) => `agent-${merchantId}`;
const ALL_SELLERS = Object.fromEntries(CATALOG.map((m) => [m.id, agentFor(m.id)]));

type Behaviour = "honest" | "tamper" | "silent";

interface StoredMessage extends BandMessage {
  mentions: BandMention[];
  processed: boolean;
}

/** In-memory stand-in for the BAND Agent API, with seller agents answering @mentions. */
class FakeBand implements BandTransport {
  readonly chats = new Map<string, { participants: BandParticipant[]; messages: StoredMessage[] }>();
  readonly sent: Array<{ chatId: string; content: string; mentions: BandMention[] }> = [];
  createCalls = 0;
  addCalls: string[] = [];
  private seq = 0;
  private listeners = new Map<string, (m: BandMessage) => void>();

  constructor(
    private readonly sellers: Record<string, { merchant: Merchant; behaviour: Behaviour }>,
    private readonly push = false,
  ) {}

  private chat(id: string) {
    const c = this.chats.get(id);
    if (!c) throw new Error(`404 chat ${id}`);
    return c;
  }

  async createChat() {
    this.createCalls += 1;
    const id = `room-${this.createCalls}`;
    this.chats.set(id, { participants: [{ id: BUYER, name: "Clearing Buyer", type: "Agent", handle: "demo/clearing-buyer" }], messages: [] });
    return { id };
  }

  async listParticipants(chatId: string) {
    return [...this.chat(chatId).participants];
  }

  async addParticipant(chatId: string, participantId: string) {
    this.addCalls.push(participantId);
    const s = this.sellers[participantId];
    const p: BandParticipant = { id: participantId, name: s?.merchant.name ?? participantId, type: "Agent", handle: `demo/${s?.merchant.id ?? participantId}` };
    this.chat(chatId).participants.push(p);
    return p;
  }

  async sendMessage(chatId: string, content: string, mentions: BandMention[]) {
    const c = this.chat(chatId);
    if (mentions.length === 0) throw new Error("422 mentions required");
    const id = `msg-${++this.seq}`;
    this.sent.push({ chatId, content, mentions });
    c.messages.push({ id, content, senderId: BUYER, senderName: "Clearing Buyer", mentions, processed: false });
    for (const m of mentions) {
      const seller = this.sellers[m.id];
      if (!seller || seller.behaviour === "silent") continue;
      // The seller process answers asynchronously, like a separate agent on a socket.
      setTimeout(() => this.sellerTurn(chatId, m.id, seller.merchant, seller.behaviour, content), 1);
    }
    return { id };
  }

  private sellerTurn(chatId: string, agentId: string, merchant: Merchant, behaviour: Behaviour, content: string) {
    const out = handleSellerMessage(merchant, { content, senderId: BUYER, senderName: "Clearing Buyer" }, { buyerAgentId: BUYER });
    if (!out) return;
    let replyContent = out.content;
    if (behaviour === "tamper" && out.payload.outcome === "revised") {
      // A seller (or anyone in the room) claims a price below its own floor.
      const offer = structuredClone(out.payload.offer) as Offer;
      offer.lines = offer.lines.map((l) => ({ ...l, unitCents: 100, lineCents: 100 * l.qty }));
      offer.totalCents = offer.lines.reduce((s, l) => s + l.lineCents, 0);
      replyContent = formatMessage("@Clearing Buyer revised", { ...out.payload, offer });
    }
    const msg: StoredMessage = { id: `msg-${++this.seq}`, content: replyContent, senderId: agentId, senderName: merchant.name, mentions: [{ id: BUYER }], processed: false };
    this.chat(chatId).messages.push(msg);
    this.listeners.get(chatId)?.(msg);
  }

  async listMessages(chatId: string) {
    return this.chat(chatId).messages.filter((m) => !m.processed && m.senderId !== BUYER && m.mentions.some((x) => x.id === BUYER));
  }

  async subscribe(chatId: string, onMessage: (m: BandMessage) => void) {
    if (!this.push) throw new Error("socket unavailable");
    this.listeners.set(chatId, onMessage);
    return () => this.listeners.delete(chatId);
  }

  async markProcessed(chatId: string, messageId: string) {
    const m = this.chat(chatId).messages.find((x) => x.id === messageId);
    if (m) m.processed = true;
  }
}

function sellersWith(behaviour: Behaviour, ids: string[] = CATALOG.map((m) => m.id)) {
  return Object.fromEntries(ids.map((id) => [agentFor(id), { merchant: catalogMerchant(id), behaviour }]));
}

function juniperAsk(): CoordinationInput {
  const demand = deriveDemand(presetRequirements());
  const offer = quoteOffer("m-juniper", demand);
  return { ask: { offerId: offer.id, merchantId: "m-juniper", lever: "volume_discount", ask: "Volume pricing for 60 meals?" }, offer, round: 1, ctx: qctxFor(demand) };
}

function coordinator(fake: BandTransport, over: Partial<Parameters<typeof createBandCoordinator>[0]> = {}): Coordinator {
  let n = 0;
  return createBandCoordinator({ transport: fake, buyerAgentId: BUYER, sellerAgents: ALL_SELLERS, catalog: CATALOG, replyTimeoutMs: 400, pollMs: 2, newAskId: () => `ask_test${String(++n).padStart(4, "0")}`, ...over });
}

const env = (vars: Record<string, string>) => ({ NODE_ENV: "test", ...vars }) as unknown as NodeJS.ProcessEnv;

beforeEach(() => resetBandLiveState());

describe("BAND coordinator (fake transport)", () => {
  it("creates the room once, adds each seller once, and reuses both across asks", async () => {
    const fake = new FakeBand(sellersWith("honest"));
    const c = coordinator(fake);
    await c.requestConcession(juniperAsk());
    await c.requestConcession(juniperAsk());
    expect(fake.createCalls).toBe(1);
    expect(fake.addCalls).toEqual([agentFor("m-juniper")]);
    expect(fake.sent).toHaveLength(2);
    expect(new Set(fake.sent.map((s) => s.chatId))).toEqual(new Set(["room-1"]));
  });

  it("reuses BAND_ROOM_ID instead of creating a room", async () => {
    const fake = new FakeBand(sellersWith("honest"));
    const { id } = await fake.createChat();
    const c = coordinator(fake, { roomId: id });
    await c.requestConcession(juniperAsk());
    expect(fake.createCalls).toBe(1);
    expect(fake.sent[0]!.chatId).toBe(id);
  });

  it("posts ONE message per ask that @mentions the seller handle and carries the JSON ask (no budget)", async () => {
    const fake = new FakeBand(sellersWith("honest"));
    const input = juniperAsk();
    await coordinator(fake).requestConcession(input);
    expect(fake.sent).toHaveLength(1);
    const msg = fake.sent[0]!;
    expect(msg.mentions).toEqual([{ id: agentFor("m-juniper"), handle: "demo/m-juniper", name: catalogMerchant("m-juniper").name }]);
    expect(msg.content.startsWith("@demo/m-juniper ")).toBe(true);
    const ask = parseAsk(msg.content);
    expect(ask).toMatchObject({ clearing: 1, askId: "ask_test0001", offerId: input.offer.id, offerRevision: 1, lever: "volume_discount", round: 1, demandSummary: { headcount: 60, vegetarianMin: 20 } });
    expect(msg.content).not.toContain("budgetCents");
    expect(msg.content).not.toContain("floorPctOfList");
  });

  it("turns a valid seller reply into a revised offer that passes the re-pricing check, with BAND evidence", async () => {
    const fake = new FakeBand(sellersWith("honest"), true);
    const c = coordinator(fake);
    const input = juniperAsk();
    const out = await c.requestConcession(input);
    const local = respond(catalogMerchant("m-juniper"), input.offer, "volume_discount", 1, input.ctx);
    expect(out.outcome).toBe("revised");
    if (out.outcome !== "revised" || local.outcome !== "revised") throw new Error("expected revisions");
    expect(out.offer.revision).toBe(input.offer.revision + 1);
    expect(out.offer.totalCents).toBe(local.offer.totalCents);
    expect(out.offer.totalCents).toBeLessThan(input.offer.totalCents);
    expect(out.offer.provenance.note).toContain("via BAND");
    expect(out.trace).toMatchObject({ transport: "band", roomId: "room-1", askId: "ask_test0001", askMessageId: "msg-1", replyMessageId: "msg-2" });
    expect(c.status()).toEqual({ connected: true, note: "Live-verified: room room-1, 1 round trips" });
    expect(bandLiveVerified()).toEqual({ roomId: "room-1", roundTrips: 1 });
    // The consumed reply was acknowledged and left the buyer's queue.
    expect(await fake.listMessages("room-1")).toHaveLength(0);
  });

  it("rejects a tampered reply (price below the policy floor) as declined with the validation reason", async () => {
    const fake = new FakeBand(sellersWith("tamper"));
    const out = await coordinator(fake).requestConcession(juniperAsk());
    expect(out.outcome).toBe("declined");
    expect(out.reply).toContain("reply failed validation");
    expect(out.trace).toMatchObject({ transport: "band", note: "prices differ from what policy allows" });
  });

  it("ignores replies from anyone but the mapped seller agent", async () => {
    const fake = new FakeBand(sellersWith("silent"));
    const c = coordinator(fake, { replyTimeoutMs: 60 });
    const pending = c.requestConcession(juniperAsk());
    await new Promise((r) => setTimeout(r, 10));
    const askMsg = fake.sent[0]!;
    const ask = parseAsk(askMsg.content)!;
    const forged = handleSellerMessage(catalogMerchant("m-juniper"), { content: askMsg.content, senderId: BUYER }, {})!;
    fake.chats.get("room-1")!.messages.push({ id: "forged", content: forged.content, senderId: "agent-impostor", mentions: [{ id: BUYER }], processed: false });
    const out = await pending;
    expect(parseReply(forged.content)?.askId).toBe(ask.askId);
    expect(out).toMatchObject({ outcome: "declined", reply: "BAND reply timed out" });
  });

  it("returns declined on timeout and on transport errors, without throwing", async () => {
    const silent = await coordinator(new FakeBand(sellersWith("silent")), { replyTimeoutMs: 30 }).requestConcession(juniperAsk());
    expect(silent).toMatchObject({ outcome: "declined", reply: "BAND reply timed out", trace: { transport: "band", roomId: "room-1" } });

    const broken: BandTransport = {
      createChat: () => Promise.reject(new TypeError("fetch failed: https://app.band.ai/... X-API-Key=secret")),
      listParticipants: async () => [],
      addParticipant: async () => null,
      sendMessage: async () => ({ id: null }),
      listMessages: async () => [],
    };
    const c = coordinator(broken);
    const out = await c.requestConcession(juniperAsk());
    expect(out.outcome).toBe("declined");
    expect(out.reply).toBe("BAND reply timed out (transport error)");
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(c.status().connected).toBe(false);
    expect(c.status().note).toContain("unverified until a round trip completes");
  });

  it("uses the local coordinator for merchants without a mapped seller agent and reports it", async () => {
    const fake = new FakeBand(sellersWith("honest", ["m-juniper"]));
    const c = coordinator(fake, { sellerAgents: { "m-juniper": agentFor("m-juniper") } });
    const demand = deriveDemand(presetRequirements());
    const offer = quoteOffer("m-goldenhour", demand);
    const input: CoordinationInput = { ask: { offerId: offer.id, merchantId: "m-goldenhour", lever: "volume_discount", ask: "Volume?" }, offer, round: 1, ctx: qctxFor(demand) };
    const out = await c.requestConcession(input);
    const local = await localCoordinator(CATALOG).requestConcession(input);
    expect(fake.sent).toHaveLength(0);
    expect(out.outcome).toBe(local.outcome);
    expect(out.trace).toMatchObject({ transport: "local", note: "no BAND seller agent mapped for this merchant" });
    expect(c.status().note).toContain("local fallback for m-goldenhour");
  });
});

describe("BAND seller agent (seller-agent.ts, run by scripts/band-seller.mts)", () => {
  const juniper = catalogMerchant("m-juniper");

  it("ignores messages without a valid Clearing payload, from other senders, or for other merchants", () => {
    expect(handleSellerMessage(juniper, { content: "@Juniper hello there", senderId: BUYER })).toBeNull();
    expect(handleSellerMessage(juniper, { content: '```json\n{"clearing":2}\n```', senderId: BUYER })).toBeNull();
    const ask = formatMessage("@Juniper ask", { clearing: 1, askId: "ask_abcdef", offerId: "x", offerRevision: 1, lever: "volume_discount", round: 1, demandSummary: { headcount: 60, vegetarianMin: 20, zone: "z", nowMin: 840 }, nowIso: "2026-10-16T21:00:00.000Z", offer: juniperAsk().offer });
    expect(handleSellerMessage(juniper, { content: ask, senderId: "someone-else" }, { buyerAgentId: BUYER })).toBeNull();
    expect(handleSellerMessage(catalogMerchant("m-harbor"), { content: ask, senderId: BUYER })).toBeNull();
  });

  it("answers with outcome and offer only — never its policy fields", () => {
    const input = juniperAsk();
    const askContent = formatMessage("@Juniper ask", { clearing: 1, askId: "ask_abcdef", offerId: input.offer.id, offerRevision: 1, lever: "volume_discount", round: 1, demandSummary: { headcount: 60, vegetarianMin: 20, zone: input.ctx.demand.zone, nowMin: input.ctx.demand.nowMin }, nowIso: input.ctx.nowIso, offer: input.offer });
    const out = handleSellerMessage(juniper, { content: askContent, senderId: BUYER, senderName: "Clearing Buyer" })!;
    expect(out.mention).toEqual({ id: BUYER, name: "Clearing Buyer" });
    expect(out.payload).toMatchObject({ clearing: 1, askId: "ask_abcdef", outcome: "revised" });
    expect(Object.keys(out.payload).sort()).toEqual(["askId", "clearing", "offer", "outcome", "reply"]);
    for (const secret of ["floorPctOfList", "volumeDiscount", "slotFlexible", "maxRounds", "policy"]) expect(out.content).not.toContain(secret);
  });
});

describe("BAND in the pipeline", () => {
  let store: Store;
  afterEach(() => store?.close());

  async function runPreset(c: Coordinator) {
    store = openStore(":memory:");
    const service = createService({ store, clock: fixedClock(), provider: localProvider(), paceMs: 0, coordinator: c });
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    const run = await service.drain(created.id);
    const negotiation = store.listEvents(run.id, 0, 10_000).filter((e: RunEvent) => e.type === "offer.revised" || e.type === "offer.declined");
    return { run, negotiation };
  }

  it("clears the preset at the same total when every seller answers through BAND, and events say coordination: band", async () => {
    const { run, negotiation } = await runPreset(coordinator(new FakeBand(sellersWith("honest"), true)));
    expect(run.phase).toBe("proposed");
    expect(run.plans.find((p) => p.revision === run.currentPlanRevision)!.totals.totalCents).toBe(EXPECTED.clearedTotalCents);
    expect(negotiation.length).toBeGreaterThan(0);
    expect(negotiation.every((e) => e.payload.coordination === "band")).toBe(true);
    const revised = negotiation.find((e) => e.type === "offer.revised")!;
    expect(revised.payload.trace).toMatchObject({ transport: "band", roomId: "room-1" });
  });

  it("still finishes (clears or reports infeasible) when BAND never replies", async () => {
    const { run, negotiation } = await runPreset(coordinator(new FakeBand(sellersWith("silent")), { replyTimeoutMs: 15 }));
    expect(["proposed", "no_feasible_plan"]).toContain(run.phase);
    expect(run.job).toBeNull();
    expect(negotiation.length).toBeGreaterThan(0);
    expect(negotiation.every((e) => e.type === "offer.declined" && e.payload.reply === "BAND reply timed out" && e.payload.coordination === "band")).toBe(true);
  });

  it("labels default runs coordination: local", async () => {
    const { negotiation } = await runPreset(localCoordinator(CATALOG));
    expect(negotiation.every((e) => e.payload.coordination === "local")).toBe(true);
  });
});

describe("BAND status and configuration", () => {
  it("is not connected without buyer agent credentials", () => {
    const s = integrationStatus(env({}));
    expect(s.band.connected).toBe(false);
    expect(s.band.note).toMatch(/^Not connected/);
    expect(s.coordination).toBe("Local transport");
    expect(bandCoordinatorFromEnv(env({ BAND_BUYER_AGENT_ID: "a" }), CATALOG)).toBeNull();
  });

  it("is configured-but-unverified until a round trip completes, then live-verified", async () => {
    const vars = env({ BAND_BUYER_AGENT_ID: BUYER, BAND_BUYER_API_KEY: "k-not-a-real-key" });
    const before = integrationStatus(vars);
    expect(before.band).toEqual({ connected: false, note: "Configured: negotiation runs through a BAND room (buyer agent + seller agent processes); unverified until a round trip completes" });
    expect(before.coordination).toBe("BAND room (unverified; local fallback)");
    expect(JSON.stringify(before)).not.toContain("k-not-a-real-key");
    await coordinator(new FakeBand(sellersWith("honest"))).requestConcession(juniperAsk());
    const after = integrationStatus(vars);
    expect(after.band).toEqual({ connected: true, note: "Live-verified: room room-1, 1 round trips" });
    expect(after.coordination).toBe("BAND room (live-verified)");
  });

  it("parses BAND_SELLER_AGENTS defensively", () => {
    expect(parseSellerAgents('{"m-juniper":"uuid-1","m-x":5}')).toEqual({ "m-juniper": "uuid-1" });
    expect(parseSellerAgents("not json")).toEqual({});
    expect(parseSellerAgents("[1]")).toEqual({});
    expect(bandCoordinatorFromEnv(env({ BAND_BUYER_AGENT_ID: "a", BAND_BUYER_API_KEY: "b" }), CATALOG)?.name).toBe("band");
  });
});
