/**
 * Shared helpers for the Clearing route handlers: body parsing with contract
 * validation, a uniform `{error: {code, message, details?}}` shape, and no
 * stack traces or secrets in responses.
 */
import type { z } from "zod";
import { ApprovalRejected, parseOrThrow, ServiceError, ValidationError } from "@/lib/service";

const MAX_BODY_CHARS = 32_000;
const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ServiceError) {
    const body: Record<string, unknown> = {
      error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
    };
    if (err instanceof ApprovalRejected) body.rejects = err.rejects;
    return json(body, err.status);
  }
  console.error("[clearing] unhandled route error:", err instanceof Error ? err.message : String(err));
  return json({ error: { code: "internal_error", message: "Unexpected server error." } }, 500);
}

/** Read a JSON body (empty body ⇒ {}), then validate it with a contract schema. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new ServiceError(413, "payload_too_large", `Request body exceeds ${MAX_BODY_CHARS} characters.`);
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ValidationError("Request body is not valid JSON.", undefined, "invalid_json");
    }
  }
  return parseOrThrow(schema, raw);
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}
