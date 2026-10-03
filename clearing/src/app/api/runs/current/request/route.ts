import { getService } from "@/lib/app";
import { SubmitRequestCommand } from "@/lib/service";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/** Submit or edit the organizer request (RequestInput). Re-opens confirmation. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, SubmitRequestCommand);
    const service = await getService();
    const current = await service.getOrCreateCurrent();
    return json({ run: await service.submitRequest(current.id, body) });
  });
}
