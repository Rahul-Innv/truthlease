/**
 * Real BAND transport for the buyer agent, built on @band-ai/sdk 0.5.0.
 *
 * Calls used (typings in node_modules/@band-ai/sdk/dist/rest.d.ts and schemas-*.d.ts):
 * - `new BandLink({ agentId, apiKey, wsUrl?, restUrl? })` — default WS
 *   wss://app.band.ai/api/v1/socket, REST base derived from it (https://app.band.ai).
 * - `link.rest.createChat()`            → POST /api/v1/agent/chats
 * - `link.rest.listChatParticipants(id)` → GET  /api/v1/agent/chats/{id}/participants
 * - `link.rest.addChatParticipant(id, { participantId, role: "member" })` → POST .../participants
 * - `link.rest.createChatMessage(id, { content, mentions })` → POST .../messages (returns data.id)
 * - `link.rest.listMessages({ chatId, page, pageSize })` → GET .../messages (unprocessed, oldest first)
 * - `link.rest.markMessageProcessing / markMessageProcessed` → POST .../messages/{mid}/processing|processed
 * - `link.connect()`, `link.subscribeRoom(id)`, `link.nextEvent(signal)` → Phoenix channel
 *   chat_room:{id}, event `message_created` (only messages that @mention this agent).
 *
 * Loaded with a dynamic import only when BAND_BUYER_* is configured. Never logs keys.
 */
import type { BandMessage, BandParticipant, BandTransport } from "./band";

interface RawMessage {
  id?: unknown;
  content?: unknown;
  sender_id?: unknown;
  sender_name?: unknown;
}

function toMessage(raw: RawMessage): BandMessage | null {
  if (typeof raw.id !== "string" || typeof raw.content !== "string" || typeof raw.sender_id !== "string") return null;
  return { id: raw.id, content: raw.content, senderId: raw.sender_id, senderName: typeof raw.sender_name === "string" ? raw.sender_name : null };
}

function toParticipant(raw: Record<string, unknown>): BandParticipant | null {
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    type: typeof raw.type === "string" ? raw.type : "Agent",
    handle: typeof raw.handle === "string" ? raw.handle : null,
  };
}

export async function sdkBandTransport(opts: { agentId: string; apiKey: string; wsUrl?: string; restUrl?: string }): Promise<BandTransport> {
  const { BandLink } = await import("@band-ai/sdk");
  const link = new BandLink({ agentId: opts.agentId, apiKey: opts.apiKey, ...(opts.wsUrl ? { wsUrl: opts.wsUrl } : {}), ...(opts.restUrl ? { restUrl: opts.restUrl } : {}) });
  const rest = link.rest;
  return {
    async createChat() {
      return rest.createChat();
    },
    async listParticipants(chatId) {
      const list = await rest.listChatParticipants(chatId);
      return list.map((p) => ({ id: p.id, name: p.name, type: p.type, handle: p.handle ?? null }));
    },
    async addParticipant(chatId, participantId) {
      const r = await rest.addChatParticipant(chatId, { participantId, role: "member" });
      return toParticipant(r);
    },
    async sendMessage(chatId, content, mentions) {
      const r = await rest.createChatMessage(chatId, { content, mentions });
      return { id: typeof r.id === "string" ? r.id : null };
    },
    async listMessages(chatId) {
      if (!rest.listMessages) return [];
      const page = await rest.listMessages({ chatId, page: 1, pageSize: 100 });
      return page.data.map((m) => toMessage(m as RawMessage)).filter((m): m is BandMessage => m !== null);
    },
    async subscribe(chatId, onMessage) {
      await link.connect();
      await link.subscribeRoom(chatId);
      const stop = new AbortController();
      void (async () => {
        while (!stop.signal.aborted) {
          const ev = await link.nextEvent(stop.signal);
          if (!ev) break;
          if (ev.type !== "message_created" || ev.roomId !== chatId) continue;
          const m = toMessage(ev.payload as RawMessage);
          if (m) onMessage(m);
        }
      })().catch(() => {
        // The poll path keeps working when the socket drops.
      });
      return () => {
        stop.abort();
        void link.disconnect().catch(() => undefined);
      };
    },
    async markProcessed(chatId, messageId) {
      await rest.markMessageProcessing(chatId, messageId);
      await rest.markMessageProcessed(chatId, messageId);
    },
  };
}
