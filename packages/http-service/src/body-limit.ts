import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorResponse, HttpServiceErrorCode } from "./errors";

/**
 * Refuses a body over `maxBytes`, by its `content-length` or, for a chunked
 * body, as it is read. The request is first rebuilt as a native `Request`
 * over the same body stream: Hono's `bodyLimit` replays a chunked body with
 * `new Request(c.req.raw, …)`, which throws on `@hono/node-server`'s
 * lightweight request when `overrideGlobalObjects` is off, as
 * `createNodeRequestListener` sets it.
 */
export function internalBodyLimit({
  maxBytes,
  status = HTTP_PAYLOAD_TOO_LARGE,
  code = HttpServiceErrorCode.PayloadTooLarge,
}: {
  maxBytes: number;
  status?: ContentfulStatusCode;
  code?: string | null;
}): MiddlewareHandler {
  const limit = bodyLimit({
    maxSize: maxBytes,
    onError: (c) => errorResponse(c, status, code),
  });
  return (c, next) => {
    const { raw } = c.req;
    if (raw.body) {
      const init: RequestInit & { duplex: "half" } = {
        method: raw.method,
        headers: raw.headers,
        body: raw.body,
        signal: raw.signal,
        duplex: "half",
      };
      c.req.raw = new Request(raw.url, init);
    }
    return limit(c, next);
  };
}

const HTTP_PAYLOAD_TOO_LARGE = 413;
