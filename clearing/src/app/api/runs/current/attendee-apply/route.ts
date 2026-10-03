import { getService } from "@/lib/app";
import { AttendeeApplyCommand } from "@/lib/attendee";
import { PhaseError } from "@/lib/service";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Organizer console: apply the aggregated attendee counts to headcount and vegetarian minimum.
 * In `confirming` this only edits the requirements; with a plan it re-quotes and repairs, and the
 * repaired plan needs fresh approval.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, AttendeeApplyCommand);
    const service = await getService();
    const current = await service.getOrCreateCurrent();
    if (body.runId !== undefined && body.runId !== current.id) {
      throw new PhaseError("This view is not showing the current run; reload the console first.", undefined, "run_mismatch");
    }
    return json({ run: await service.applyAttendeeCounts(current.id, body) });
  });
}
