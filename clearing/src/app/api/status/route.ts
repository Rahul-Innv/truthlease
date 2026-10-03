import { integrationStatus } from "@/lib/providers/status";
import { handle, json } from "../_lib/http";

export const dynamic = "force-dynamic";

/** Integration status: presence-only checks, never credential values. */
export async function GET() {
  return handle(async () => json(integrationStatus()));
}
