import { ApproveCommand } from "@/lib/contracts";
import { handle, json, readBody } from "../../_lib/http";
import { withAgentRuntime } from "../_lib/context";
import { withRateLimit } from "../_lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * Approval stays with the organizer. Only when the operator sets
 * CLEARING_AGENT_CAN_APPROVE=true does this delegate to the same service command as the
 * console route (idempotent, optimistic version, revalidation of the exact offers).
 */
export async function POST(request: Request) {
  return withRateLimit(request, () =>
    handle(async () => {
      if (process.env.CLEARING_AGENT_CAN_APPROVE !== "true") {
        return json(
          {
            error: {
              code: "approval_requires_organizer",
              message: "Approval stays with the organizer. Ask the organizer to review the proposed plan in the Clearing console and approve it there.",
            },
          },
          403,
        );
      }
      const body = await readBody(request, ApproveCommand);
      return withAgentRuntime(async ({ service }) => {
        const current = await service.getOrCreateCurrent();
        return json({ run: await service.approve(current.id, body) });
      });
    }),
  );
}
