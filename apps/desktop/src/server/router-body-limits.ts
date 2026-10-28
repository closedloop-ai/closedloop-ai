import type { ServerResponse } from "node:http";
import { gatewayLog } from "../main/logging/gateway-logger.js";

/**
 * Per-route request body caps for the desktop gateway, and the strict
 * `Content-Length` parsing `readBody` enforces them with.
 *
 * Split out of `router.ts` (ISS-8566) because these are a self-contained
 * size-policy concern with no `this`, no auth involvement, and no response
 * object: the router only needs the number a route is allowed to read. Keeping
 * them here also keeps the caps readable as one table rather than as constants
 * scattered a thousand lines from the function that selects between them.
 */

export const REQUEST_BODY_TOO_LARGE_CODE = "request_body_too_large";

const GENERIC_JSON_LIMIT_BYTES = 256 * 1024;
const DECIMAL_DIGITS_ONLY = /^\d+$/;

export class RequestBodyTooLargeError extends Error {
  readonly code = REQUEST_BODY_TOO_LARGE_CODE;
  readonly limitBytes: number;
  readonly routeName: string;
  readonly declaredSizeBytes?: number;
  readonly observedSizeBytes?: number;

  constructor(input: {
    limitBytes: number;
    routeName: string;
    declaredSizeBytes?: number;
    observedSizeBytes?: number;
  }) {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
    this.limitBytes = input.limitBytes;
    this.routeName = input.routeName;
    this.declaredSizeBytes = input.declaredSizeBytes;
    this.observedSizeBytes = input.observedSizeBytes;
  }
}

export type RequestBodyLimit = {
  limitBytes: number;
  routeName: string;
};

/** The in-code request cap every gateway route reads its body under. */
export const GATEWAY_REQUEST_BODY_LIMIT: RequestBodyLimit = {
  limitBytes: GENERIC_JSON_LIMIT_BYTES,
  routeName: "generic-json",
};

export function parseStrictContentLength(value: string | null): bigint | null {
  if (!(value && DECIMAL_DIGITS_ONLY.test(value))) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function bigintToSafeNumber(value: bigint): number | undefined {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(value);
}

export function writeRequestTooLargeResponse(
  response: ServerResponse,
  error: RequestBodyTooLargeError
): void {
  response.statusCode = 413;
  response.setHeader("content-type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(
    JSON.stringify({
      error: "request body too large",
      code: REQUEST_BODY_TOO_LARGE_CODE,
      maxBytes: error.limitBytes,
    })
  );
}

export function logOversizedRequest(
  method: string,
  path: string,
  error: RequestBodyTooLargeError
): void {
  gatewayLog.warn(
    "gateway-router",
    [
      REQUEST_BODY_TOO_LARGE_CODE,
      `method=${method}`,
      `path=${path}`,
      "status=413",
      `route=${error.routeName}`,
      `limitBytes=${error.limitBytes}`,
      `declaredSizeBytes=${error.declaredSizeBytes ?? "absent"}`,
      `observedSizeBytes=${error.observedSizeBytes ?? "absent"}`,
    ].join(" ")
  );
}
