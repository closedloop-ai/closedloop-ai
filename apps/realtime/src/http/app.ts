import type { IncomingMessage, ServerResponse } from "node:http";
import { emptyNotFound, serviceErrorHandler } from "@repo/http-service/errors";
import {
  createNodeRequestListener,
  type NodeBindings,
  rawRequestPath,
} from "@repo/http-service/node-listener";
import { Hono } from "hono";
import type { Readiness } from "../lifecycle/readiness";
import { healthRoutes } from "./health";
import { type InternalHandlerOptions, internalRoutes } from "./internal";

export type RealtimeHttpDeps = {
  readiness: Readiness;
  internal: InternalHandlerOptions;
};

/**
 * Every HTTP route realtime serves (ISS-12589): `/health`, `/ready` and
 * `/internal/*`, matched on the raw request path. socket.io answers its own
 * path and every upgrade before a request reaches this app.
 */
function createRealtimeHttpApp(
  deps: RealtimeHttpDeps
): Hono<{ Bindings: NodeBindings }> {
  const app = new Hono<{ Bindings: NodeBindings }>({ getPath: rawRequestPath });
  app.route("/", healthRoutes(deps.readiness));
  app.route("/", internalRoutes(deps.internal));
  app.notFound(emptyNotFound);
  app.onError(
    serviceErrorHandler(HTTP_REQUEST_FAULT_EVENT, {
      message: HTTP_REQUEST_FAULT_MESSAGE,
      code: null,
    })
  );
  return app;
}

export function createRealtimeRequestListener(
  deps: RealtimeHttpDeps
): (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void> {
  return createNodeRequestListener(createRealtimeHttpApp(deps), {
    faultEvent: HTTP_REQUEST_FAULT_EVENT,
    hostname: REQUEST_HOST_FALLBACK,
  });
}

export const HTTP_REQUEST_FAULT_EVENT = "realtime.http_request_fault";
export const HTTP_REQUEST_FAULT_MESSAGE = "Realtime HTTP request failed";
/** Read as the Host of a request that sent none, as an HTTP/1.0 probe may not. */
const REQUEST_HOST_FALLBACK = "localhost";
