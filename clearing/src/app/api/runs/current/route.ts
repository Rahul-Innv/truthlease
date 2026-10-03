import { getService, rearmJob } from "@/lib/app";
import { integrationStatus } from "@/lib/providers/status";
import { handle, json } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** Current run (the preset run is created on first access) plus integration status. */
export async function GET() {
  return handle(async () => {
    const service = await getService();
    const run = await service.getOrCreateCurrent();
    rearmJob(service, run);
    return json({ run, status: integrationStatus() });
  });
}
