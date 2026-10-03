import { withService } from "@/lib/app";
import { AttendeeSubmitBody } from "@/lib/attendee";
import { handle, json, readBody } from "../../_lib/http";
import { attendRateLimited, takeAttendToken } from "../_lib/limit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/**
 * Public attendee link. Returns only the event summary and aggregate counts:
 * {objective, eventDate, timezone, readyByLocal, venueName, summary, enabled}.
 * No budget, plan, offers, orders or run id. 404 for unknown tokens.
 */
export async function GET(_request: Request, { params }: Ctx) {
  return handle(async () => {
    const { token } = await params;
    return withService(async (service) => json(service.getAttendeeView(token)), { token });
  });
}

/**
 * Public submit: {respondentId, preference, partySize}. One answer per respondentId (re-submitting
 * updates it). 404 for unknown or disabled tokens; 429 above 10 submissions per minute per client.
 */
export async function POST(request: Request, { params }: Ctx) {
  const t = takeAttendToken(request);
  if (!t.ok) return attendRateLimited(t.retryAfterSeconds);
  return handle(async () => {
    const { token } = await params;
    const body = await readBody(request, AttendeeSubmitBody);
    return withService(async (service) => json(await service.submitAttendee({ token, ...body })), { token });
  });
}
