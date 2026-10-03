import { handle, json, readBody } from "../../_lib/http";
import { agentRuntime } from "../_lib/context";
import { withRateLimit } from "../_lib/ratelimit";
import { AgentConfirmBody } from "../_lib/schemas";

export const dynamic = "force-dynamic";

/**
 * Confirm requirements (optionally with edits) and open the market.
 * Mirrors the console confirm route: the service's `scheduleJob` arms the background
 * job runner; GET /api/agent/plan re-arms a stored job after a restart.
 */
export async function POST(request: Request) {
  return withRateLimit(request, () =>
    handle(async () => {
      const body = await readBody(request, AgentConfirmBody);
      const { service } = await agentRuntime();
      const current = await service.getOrCreateCurrent();
      const run = await service.confirmRequirements(current.id, body);
      return json({ runId: run.id, phase: run.phase });
    }),
  );
}
