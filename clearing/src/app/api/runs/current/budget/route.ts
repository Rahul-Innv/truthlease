import { getService } from "@/lib/app";
import { UpdateBudgetCommand } from "@/lib/contracts";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/** Change the budget; re-runs clearing or repair with the existing open offers (no re-quote). */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, UpdateBudgetCommand);
    const service = await getService();
    const current = await service.getOrCreateCurrent();
    return json({ run: await service.updateBudget(current.id, body) });
  });
}
