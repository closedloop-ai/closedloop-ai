import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { z } from "zod";
import { ApiError } from "./api-error";

const rawErrorBodySchema = z
  .object({
    code: z.string().optional(),
    details: z.unknown().optional(),
    error: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export type ParsedRawErrorBody = {
  code?: string;
  details?: JsonObject;
  error?: string;
  timestamp?: string;
};

/**
 * Extract the human-readable message from a raw gateway error body.
 * Metadata codes are intentionally lower precedence than `error`.
 */
export function extractRawErrorMessage(
  body: unknown,
  fallback = "API request failed"
): string {
  const parsed = parseRawErrorBody(body);
  return getRawErrorMessage(parsed, fallback);
}

export function parseRawErrorBody(body: unknown): ParsedRawErrorBody | null {
  const parsed = rawErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const details = isJsonObject(parsed.data.details)
    ? parsed.data.details
    : undefined;
  return {
    ...(parsed.data.code ? { code: parsed.data.code } : {}),
    ...(details ? { details } : {}),
    ...(parsed.data.error ? { error: parsed.data.error } : {}),
    ...(parsed.data.timestamp ? { timestamp: parsed.data.timestamp } : {}),
  };
}

/**
 * Read a failed raw response once and throw the app's standard ApiError.
 * Legacy `{ error }`, enriched `{ error, code, details }`, non-JSON, and
 * future unknown codes all share this tolerant path.
 */
export async function throwApiErrorFromResponse(
  response: Response,
  fallback = "API request failed"
): Promise<never> {
  const body = await response.json().catch(() => null);
  const parsed = parseRawErrorBody(body);
  throw new ApiError(getRawErrorMessage(parsed, fallback), response.status, {
    code: parsed?.code,
    data: body,
    details: parsed?.details,
    timestamp: parsed?.timestamp,
  });
}

function getRawErrorMessage(
  parsed: ParsedRawErrorBody | null,
  fallback: string
): string {
  return parsed?.error ?? parsed?.code ?? fallback;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}
