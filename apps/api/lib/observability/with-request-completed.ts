import { AsyncLocalStorage } from "node:async_hooks";
import { logRequestCompleted } from "../route-utils";
import { SSE_CONTENT_TYPE } from "../sse-stream";
import { readResponseErrorCode } from "./request-error-code";
import { readRouteParams } from "./request-route-path";
import { runWithRequestSpanAttribution } from "./request-span-attribution";

/**
 * Emit `request_completed` for a route that does not go through an auth
 * wrapper (ISS-9053).
 *
 * `logRequestCompleted` runs only from the `finally` of `withAuth`,
 * `withApiKeyAuth` and `withDesktopSessionAuth`, so a route that authenticates
 * itself — every `/webhooks/*` receiver verifies its own provider signature —
 * emitted no `request_completed` on any path, and `/webhooks/github`, the
 * highest-volume route in cl-api, was invisible to every monitor keyed on it.
 * This is the same emit, inside the same attribution scope: one record shape,
 * not a second one.
 *
 * A throw that escapes the handler is recorded as 500 and rethrown, so it
 * still reaches Next exactly as it did before and the status the caller
 * receives — and a webhook provider's retry decision — is unchanged; 500 is
 * what Next answers with.
 *
 * An SSE response is recorded when its stream ends — closed by the route,
 * cancelled by the client, or errored — not when the handler returns (#8205
 * review, whitlockk). The handler returns as soon as the stream is built, so a
 * record emitted there would carry setup time as the duration of a connection
 * that can stay open for minutes. The emit is bound to the request's async
 * context so the attribution the route recorded during setup still reaches it.
 * A stream the platform kills at `maxDuration` never ends in-process and is not
 * recorded, the same way its route's own teardown never runs.
 *
 * For the webhook receivers and the `/preview-schemas` routes this emit is also
 * the SOLE terminal `scheduleLogFlush()` owner, which is why they no longer
 * schedule one of their own: `logRequestCompleted` flushes, so a route-side
 * flush ahead of it would both double the deferred work every request queues —
 * two log flushes, and with tracing active two post-response span flushes — and
 * run BEFORE the record it is meant to carry was even emitted. A receiver that
 * adds its own flush back is caught by `webhook-body-caps.test.ts`, a
 * preview-schema route by its own route suite.
 *
 * A bounded reader's `logRequestBodyOverCap` still flushes on the over-cap path
 * and is deliberately left alone: it fires only there, and exists for the
 * callers that answer their own 413 with nothing downstream to flush them.
 */
export function withRequestCompleted<
  TRequest extends Request,
  TArgs extends unknown[],
>(
  handler: (request: TRequest, ...args: TArgs) => Response | Promise<Response>
): (request: TRequest, ...args: TArgs) => Promise<Response> {
  return (request, ...args) =>
    runWithRequestSpanAttribution(async () => {
      const startMs = globalThis.performance.now();
      // Not awaited before the handler: an await here lets a streamed body
      // pull another chunk ahead of the handler's own body cap.
      const pendingRouteParams = readRouteParams(args[0]);
      let response: Response;
      try {
        response = await handler(request, ...args);
      } catch (error) {
        logRequestCompleted(
          request,
          startMs,
          500,
          undefined,
          await pendingRouteParams
        );
        throw error;
      }
      const routeParams = await pendingRouteParams;
      const { body, status } = response;
      const isEventStream = response.headers
        .get("content-type")
        ?.startsWith(SSE_CONTENT_TYPE);
      if (!(body && isEventStream)) {
        logRequestCompleted(
          request,
          startMs,
          status,
          await readResponseErrorCode(response),
          routeParams
        );
        return response;
      }
      const complete = AsyncLocalStorage.bind(() =>
        logRequestCompleted(request, startMs, status, undefined, routeParams)
      );
      // `flush` runs when the route closes the stream; `cancel` when the client
      // disconnects or the stream errors (Node 24). The lib `Transformer` type
      // does not declare `cancel` yet, hence the widened annotation.
      const endOfStream: Transformer<Uint8Array, Uint8Array> & {
        cancel: () => void;
      } = { flush: complete, cancel: complete };
      return new Response(
        body.pipeThrough(new TransformStream(endOfStream)),
        response
      );
    });
}
