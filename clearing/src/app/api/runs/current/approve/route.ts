import { getService } from "@/lib/app";
import { ApproveCommand } from "@/lib/contracts";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/** Organizer approval of the current proposed plan revision. 409 with `rejects` when revalidation fails. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, ApproveCommand);
    const service = await getService();
    const current = await service.getOrCreateCurrent();
    return json({ run: await service.approve(current.id, body) });
  });
}
