import { DEFAULT_NOW_LOCAL, DEFAULT_TIMEZONE } from "@/lib/fixtures";
import { ServiceError, ValidationError } from "@/lib/service";
import { nextDemoEventDate } from "@/lib/time";
import { handle, json, readBody } from "../../_lib/http";
import { withAgentRuntime } from "../_lib/context";
import { withRateLimit } from "../_lib/ratelimit";
import { AgentRequestBody } from "../_lib/schemas";
import { requestNextAction, requirementsView } from "../_lib/views";

export const dynamic = "force-dynamic";

interface AppliedDefault {
  field: "eventDate" | "timezone" | "nowLocal";
  value: string;
  note: string;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ValidationError(`Unknown IANA time zone "${timeZone.slice(0, 64)}".`, { timezone: timeZone }, "invalid_timezone");
  }
}

/**
 * Submit a request for the current run. Omitted eventDate / timezone / nowLocal get
 * documented defaults and are reported back in `assumptionsApplied`.
 */
export async function POST(request: Request) {
  return withRateLimit(request, () =>
    handle(async () => {
      const body = await readBody(request, AgentRequestBody);
      return withAgentRuntime(async ({ service, now }) => {

        const timezone = body.timezone ?? DEFAULT_TIMEZONE;
        assertTimeZone(timezone);
        const eventDate = body.eventDate ?? nextDemoEventDate(now(), timezone);
        const nowLocal = body.nowLocal ?? DEFAULT_NOW_LOCAL;

        const current = await service.getOrCreateCurrent();
        const run = await service.submitRequest(current.id, {
          text: body.text,
          eventDate,
          timezone,
          nowLocal,
          ...(body.venueName !== undefined ? { venueName: body.venueName } : {}),
          idempotencyKey: body.idempotencyKey,
        });
        const req = run.requirements;
        if (!req) throw new ServiceError(500, "internal_error", "The request was stored without interpreted requirements.");

        // Report values from the stored run, so a replayed idempotency key reports what was actually applied.
        const assumptionsApplied: AppliedDefault[] = [];
        if (body.timezone === undefined) assumptionsApplied.push({ field: "timezone", value: run.request.timezone, note: "Defaulted to the demo timezone." });
        if (body.eventDate === undefined) assumptionsApplied.push({ field: "eventDate", value: run.request.eventDate, note: "Defaulted to the next demo Friday (at least 3 days out) in the timezone." });
        if (body.nowLocal === undefined) assumptionsApplied.push({ field: "nowLocal", value: run.request.nowLocal, note: "Defaulted to a simulated event clock of 14:00 local on the event date." });

        return json({
          runId: run.id,
          phase: run.phase,
          requirements: requirementsView(req),
          assumptionsApplied,
          nextAction: requestNextAction(req),
        });
      });
    }),
  );
}
