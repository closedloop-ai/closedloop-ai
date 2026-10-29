import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse, readBody } from "./http-io.js";
import { INTERNAL_API_SECRET } from "./relay-env.js";

export function validateSecret(
  headerValue: string | string[] | undefined
): boolean {
  if (typeof headerValue !== "string" || !INTERNAL_API_SECRET) {
    return false;
  }
  const digestKey = "relay-constant-time-compare";
  const expectedDigest = createHmac("sha256", digestKey)
    .update(INTERNAL_API_SECRET, "utf8")
    .digest();
  const actualDigest = createHmac("sha256", digestKey)
    .update(headerValue, "utf8")
    .digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

type DispatchPayload = { targetId: string; operation: unknown };

type DispatchParseResult =
  | { ok: true; payload: DispatchPayload }
  | { ok: false; error: string };

// Pure validation, decoupled from the HTTP cycle so it can be unit-tested in
// isolation. Callers own the response: parseDispatchBody below sends the 400.
export function parseDispatchPayload(raw: string): DispatchParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).targetId !== "string"
  ) {
    return { ok: false, error: "Missing targetId" };
  }

  return { ok: true, payload: body as DispatchPayload };
}

export async function parseDispatchBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<DispatchPayload | null> {
  const result = parseDispatchPayload(await readBody(req));
  if (!result.ok) {
    jsonResponse(res, 400, { error: result.error });
    return null;
  }
  return result.payload;
}
