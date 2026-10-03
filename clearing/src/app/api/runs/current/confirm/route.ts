import { withService } from "@/lib/app";
import { ConfirmCommand } from "@/lib/service";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/** Confirm requirements (optionally with edits) and open the market (starts the collect job). */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, ConfirmCommand);
    return withService(async (service) => {
      const current = await service.getOrCreateCurrent();
      return json({ run: await service.confirmRequirements(current.id, body) });
    });
  });
}
