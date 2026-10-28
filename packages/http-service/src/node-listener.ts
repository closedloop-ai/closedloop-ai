import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getRequestListener,
  type HttpBindings,
  RequestError,
} from "@hono/node-server";
import { log } from "@repo/observability/log";
import type { Hono } from "hono";
import { describeCause } from "./describe-cause";

export type NodeBindings = HttpBindings;

/**
 * Hono's `getPath` for a service: the request-target exactly as sent, up to
 * the first `?`, with no decoding or normalization, so `..` segments,
 * percent-encoding and absolute-form targets match no route instead of being
 * normalized into one. Without a Node binding (an in-process `app.request()`),
 * the URL's pathname.
 */
export function rawRequestPath(
  request: Request,
  options?: { env?: NodeBindings }
): string {
  const target = options?.env?.incoming?.url;
  if (target === undefined) {
    return new URL(request.url).pathname;
  }
  const query = target.indexOf("?");
  return query === -1 ? target : target.slice(0, query);
}

/**
 * Serves `app` on an existing `node:http` server. The global `Request` and
 * `Response` are left alone (Hocuspocus builds its own), a request with no
 * Host header is read as `hostname`, and the returned promise never rejects:
 * a fault is logged under `faultEvent` and answered 500 with an empty body. A
 * request Node could not turn into a `Request` (an invalid Host) answers an
 * empty 400, as `@hono/node-server` does by default.
 */
export function createNodeRequestListener<E extends { Bindings: NodeBindings }>(
  app: Hono<E>,
  { faultEvent, hostname }: { faultEvent: string; hostname?: string }
): (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void> {
  const fault = (error: unknown): void => {
    log.error("Internal HTTP request fault", {
      event: faultEvent,
      cause: describeCause(error),
    });
  };
  const listener = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    hostname,
    errorHandler: (error) => {
      if (error instanceof RequestError) {
        return emptyNodeResponse(HTTP_BAD_REQUEST);
      }
      fault(error);
      return emptyNodeResponse(HTTP_INTERNAL_ERROR);
    },
  });
  return async (incoming, outgoing) => {
    try {
      await listener(incoming, outgoing);
    } catch (error) {
      fault(error);
      if (!outgoing.headersSent) {
        outgoing.writeHead(HTTP_INTERNAL_ERROR, { "content-length": "0" });
      }
      outgoing.end();
    }
  };
}

function emptyNodeResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "content-length": "0", "cache-control": "no-store" },
  });
}

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;
