import { withService } from "@/lib/app";
import { DisruptCommand } from "@/lib/contracts";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/** Inject a typed disruption (supplier unavailable, delivery delayed, headcount changed); starts repair. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, DisruptCommand);
    return withService(async (service) => {
      const current = await service.getOrCreateCurrent();
      return json({ run: await service.disrupt(current.id, body) });
    });
  });
}
