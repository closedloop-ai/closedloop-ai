import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { describeCause } from "./describe-cause";

/** The `code` of a refusal body. Each middleware's `code` option defaults to one of these. */
export const HttpServiceErrorCode = {
  Unauthorized: RealtimeErrorCode.Unauthorized,
  RateLimited: RealtimeErrorCode.RateLimited,
  PayloadTooLarge: RealtimeErrorCode.PayloadTooLarge,
  Internal: RealtimeErrorCode.Internal,
  InvalidBody: "invalid_body",
  NotFound: "not_found",
} as const;
export type HttpServiceErrorCode =
  (typeof HttpServiceErrorCode)[keyof typeof HttpServiceErrorCode];

export const httpServiceErrorBodySchema = z.object({
  code: z.string().min(1),
});

/** No body, sent with `content-length: 0` rather than chunked, and never cached. */
export function emptyResponse(c: Context, status: StatusCode): Response {
  return c.body(null, status, {
    "content-length": "0",
    "cache-control": NO_STORE,
  });
}

/** `{ code }` when `code` is a string; an empty body when it is `null` or absent. */
export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code?: string | null
): Response {
  if (typeof code === "string") {
    return c.json({ code }, status, { "cache-control": NO_STORE });
  }
  return emptyResponse(c, status);
}

/** For `app.onError`: logs the fault under `event` and answers 500, never Hono's text body. */
export function serviceErrorHandler(
  event: string,
  {
    message = "Internal HTTP request failed",
    code = HttpServiceErrorCode.Internal,
  }: { message?: string; code?: string | null } = {}
): ErrorHandler {
  return (error, c) => {
    log.error(message, {
      event,
      path: c.req.path,
      cause: describeCause(error),
    });
    return errorResponse(c, HTTP_INTERNAL_ERROR, code);
  };
}

/** For `app.notFound`: an empty 404, never Hono's text body. */
export const emptyNotFound: NotFoundHandler = (c) =>
  emptyResponse(c, HTTP_NOT_FOUND);

const NO_STORE = "no-store";
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
