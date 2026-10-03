import { getService } from "@/lib/app";
import { handle, json } from "../_lib/http";

export const dynamic = "force-dynamic";

/** Delete all runs and events and recreate the preset run (opens in `confirming`). */
export async function POST() {
  return handle(async () => {
    const service = await getService();
    return json({ run: await service.reset() });
  });
}
