import { handle, json } from "../_lib/http";
import { agentManifest } from "./_lib/manifest";
import { withRateLimit } from "./_lib/ratelimit";

export const dynamic = "force-dynamic";

/** Capability manifest: what Clearing offers an agent, the honesty labels, and where authority stops. */
export async function GET(request: Request) {
  return withRateLimit(request, () => handle(async () => json(agentManifest(process.env.CLEARING_AGENT_CAN_APPROVE === "true"))));
}
