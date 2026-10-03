/** Request bodies for the agent front door. Strict: unknown keys are rejected rather than silently dropped. */
import { z } from "zod";
import { IdempotencyKey, IsoDate, LocalTime, ShortText } from "@/lib/contracts";
import { ConfirmEdits } from "@/lib/service";

export const AgentRequestBody = z.strictObject({
  text: z.string().min(1).max(2_000),
  eventDate: IsoDate.optional(),
  timezone: z.string().min(1).max(64).optional(),
  nowLocal: LocalTime.optional(),
  venueName: ShortText.optional(),
  idempotencyKey: IdempotencyKey,
});
export type AgentRequestBody = z.infer<typeof AgentRequestBody>;

export const AgentConfirmBody = z.strictObject({
  edits: ConfirmEdits.optional(),
  idempotencyKey: IdempotencyKey,
});
export type AgentConfirmBody = z.infer<typeof AgentConfirmBody>;
