import { z } from "zod";

export const RealtimeErrorCode = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  UnknownKind: "unknown_kind",
  BadScope: "bad_scope",
  RateLimited: "rate_limited",
  PayloadTooLarge: "payload_too_large",
  TokenExpired: "token_expired",
  Internal: "internal",
} as const;
export type RealtimeErrorCode =
  (typeof RealtimeErrorCode)[keyof typeof RealtimeErrorCode];

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(RealtimeErrorCode)
);

/**
 * A peer on a newer protocol may send a code this build does not know; it is
 * read as the generic `internal` rather than rejected (PLN-2103).
 */
export function toRealtimeErrorCode(value: string): RealtimeErrorCode {
  return isRealtimeErrorCode(value) ? value : RealtimeErrorCode.Internal;
}

export function isRealtimeErrorCode(value: string): value is RealtimeErrorCode {
  return KNOWN_ERROR_CODES.has(value);
}

export const realtimeErrorCodeSchema = z
  .string()
  .min(1)
  .transform(toRealtimeErrorCode);
