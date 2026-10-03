import { getService } from "@/lib/app";
import { SettleRefundCommand } from "@/lib/contracts";
import { handle, json, readBody } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/** Settle a pending simulated refund; pending refunds never restore budget until settled. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readBody(request, SettleRefundCommand);
    const service = await getService();
    const current = await service.getOrCreateCurrent();
    return json({ run: await service.settleRefund(current.id, body) });
  });
}
