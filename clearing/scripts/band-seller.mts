/**
 * BAND seller agent — one process per merchant.
 *
 *   BAND_SELLER_MERCHANT=m-juniper BAND_AGENT_ID=<uuid> BAND_API_KEY=<key> \
 *     npx tsx scripts/band-seller.mts
 *
 * Optional: BAND_BUYER_AGENT_ID=<uuid> answers asks from that buyer agent only.
 *
 * Connects with the @band-ai/sdk run loop (`Agent.create` + `GenericAdapter`,
 * `agent.run()` opens the WebSocket and dispatches messages that @mention this
 * agent). Each message is parsed for a Clearing ask; anything else is ignored.
 * The process holds only its own merchant's catalog and private policy, prices
 * every revision with `seller.respond`, and replies in the room @mentioning the
 * buyer. The reply carries the outcome and offer, never the policy.
 */
import { Agent, GenericAdapter } from "@band-ai/sdk";
import { getMerchant } from "../src/lib/catalog";
import { handleSellerMessage } from "../src/lib/coordination/seller-agent";

const merchantId = process.env.BAND_SELLER_MERCHANT ?? "";
const agentId = process.env.BAND_AGENT_ID ?? "";
const apiKey = process.env.BAND_API_KEY ?? "";
const buyerAgentId = process.env.BAND_BUYER_AGENT_ID || undefined;

if (!merchantId || !agentId || !apiKey) {
  console.error("Usage: BAND_SELLER_MERCHANT=m-juniper BAND_AGENT_ID=<uuid> BAND_API_KEY=<key> npx tsx scripts/band-seller.mts");
  process.exit(2);
}

// Only this merchant is kept; the rest of the catalog is never referenced by this process.
const merchant = getMerchant(merchantId);
if (!merchant) {
  console.error(`Unknown merchant "${merchantId}".`);
  process.exit(2);
}

const tag = `[band-seller ${merchant.id}]`;

const agent = Agent.create({
  agentId,
  apiKey,
  adapter: new GenericAdapter(async ({ message, tools, roomId }) => {
    const out = handleSellerMessage(merchant, { content: message.content, senderId: message.senderId, senderName: message.senderName }, buyerAgentId ? { buyerAgentId } : {});
    if (!out) {
      console.log(`${tag} ignored message ${message.id} in room ${roomId} (no valid Clearing ask for this seller)`);
      return;
    }
    const sent = await tools.sendMessage(out.content, [out.mention]);
    const replyId = typeof sent.id === "string" ? sent.id : "unknown";
    console.log(`${tag} room ${roomId}: ask ${out.payload.askId} (message ${message.id}) → ${out.payload.outcome} (message ${replyId})`);
  }),
});

console.log(`${tag} connecting as agent ${agentId} (API key not logged)…`);
await agent.run();
