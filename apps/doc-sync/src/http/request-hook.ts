import type { onRequestPayload } from "@hocuspocus/server";
import {
  createNodeRequestListener,
  type NodeBindings,
} from "@repo/http-service/node-listener";
import type { Hono } from "hono";

/**
 * The Hocuspocus `onRequest` hook: hands every HTTP request to `app`. It
 * always rejects with no value, once the answer is written: that is
 * Hocuspocus's signal that the request was answered, where resolving would
 * append its welcome page and a rejection with an error would be rethrown.
 */
export function honoRequestHook(
  app: Hono<{ Bindings: NodeBindings }>
): (payload: Pick<onRequestPayload, "request" | "response">) => Promise<void> {
  const listener = createNodeRequestListener(app, {
    faultEvent: DOC_SYNC_HTTP_REQUEST_FAULT_EVENT,
    hostname: "localhost",
  });
  return ({ request, response }) =>
    listener(request, response).then(() => Promise.reject());
}

export const DOC_SYNC_HTTP_REQUEST_FAULT_EVENT = "doc_sync.http_request_fault";
