import { progressOnRead, withService } from "@/lib/app";
import { integrationStatus } from "@/lib/providers/status";
import { handle, json } from "../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Current run (the preset run is created on first access) plus integration status.
 * SQLite: re-arms a stored job's runner. Supabase (serverless): advances a pending job
 * by up to 3 steps (2 s budget) before responding — work on read.
 */
export async function GET() {
  return handle(async () =>
    withService(async (service) => {
      const run = await progressOnRead(service, await service.getOrCreateCurrent());
      return json({ run, status: integrationStatus() });
    }),
  );
}
