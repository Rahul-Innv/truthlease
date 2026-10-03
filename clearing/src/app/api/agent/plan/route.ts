import { handle, json } from "../../_lib/http";
import { withAgentRuntime } from "../_lib/context";
import { withRateLimit } from "../_lib/ratelimit";
import { planView } from "../_lib/views";

export const dynamic = "force-dynamic";

/** The current plan (compact), or the honest infeasibility summary, with the honesty labels. */
export async function GET(request: Request) {
  return withRateLimit(request, () =>
    handle(async () => {
      return withAgentRuntime(async ({ service, progress }) => {
        const run = await progress(await service.getOrCreateCurrent());
        return json(planView(run, process.env.CLEARING_AGENT_CAN_APPROVE === "true"));
      });
    }),
  );
}
