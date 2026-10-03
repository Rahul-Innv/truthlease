import { withService } from "@/lib/app";
import { AttendeeLinkCommand } from "@/lib/attendee";
import { PhaseError } from "@/lib/service";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Organizer console: create the current run's public attendee link (submit-only).
 * Returns `{run}`; the token is in `run.attendeeLink` and never in the event log.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, AttendeeLinkCommand);
    return withService(async (service) => {
      const current = await service.getOrCreateCurrent();
      if (body.runId !== undefined && body.runId !== current.id) {
        throw new PhaseError("This view is not showing the current run; reload the console first.", undefined, "run_mismatch");
      }
      return json({ run: await service.createAttendeeLink(current.id, body) });
    });
  });
}
