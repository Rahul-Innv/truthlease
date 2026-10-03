import { handle, json } from "../../_lib/http";
import { agentRuntime } from "../_lib/context";
import { withRateLimit } from "../_lib/ratelimit";
import { planView } from "../_lib/views";

export const dynamic = "force-dynamic";

/** The current plan (compact), or the honest infeasibility summary, with the honesty labels. */
export async function GET(request: Request) {
  return withRateLimit(request, () =>
    handle(async () => {
      const { service, rearm } = await agentRuntime();
      const run = await service.getOrCreateCurrent();
      rearm(run);
      return json(planView(run, process.env.CLEARING_AGENT_CAN_APPROVE === "true"));
    }),
  );
}
