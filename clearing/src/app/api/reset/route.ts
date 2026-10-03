import { withService } from "@/lib/app";
import { handle, json } from "../_lib/http";

export const dynamic = "force-dynamic";

/** Delete all runs and events and recreate the preset run (opens in `confirming`). */
export async function POST() {
  return handle(async () => {
    return withService(async (service) => {
      return json({ run: await service.reset() });
    });
  });
}
