// Shared fixture for driving symphony-loop operation handlers directly.
//
// The handlers registered by `registerSymphonyLoopRoutes` take an
// `OperationRequestContext` and write their answer onto `context.response`
// rather than returning it, so every test that asserts a status code needs the
// same recording stand-in. Centralized here so the response-capture shape lives
// in one place instead of being re-derived per suite.

import type http from "node:http";
import { PassThrough } from "node:stream";
import type {
  OperationHandler,
  OperationRequestContext,
} from "../../src/server/operation-dispatcher.js";

/** An `OperationRequestContext` that also exposes what the handler answered. */
export type RecordingOperationContext = OperationRequestContext & {
  readonly responseStatus: number;
  readonly responseBody: string;
};

/** A route captured from a fake dispatcher passed to a `register*Routes` call. */
export type CapturedRoute = {
  method: string;
  path: string;
  handler: OperationHandler;
};

/**
 * Build a request context for a symphony-loop operation whose response status
 * and body are readable afterwards.
 */
export function buildSymphonyLoopContext(
  body: Record<string, unknown>,
  options?: { method?: string; pathname?: string }
): RecordingOperationContext {
  const bodyStr = JSON.stringify(body);
  const request = new PassThrough() as unknown as http.IncomingMessage;
  const response = new PassThrough() as unknown as http.ServerResponse;
  let responseStatus = 0;
  let responseBody = "";

  Object.defineProperty(response, "statusCode", {
    get: () => responseStatus,
    set: (value: number) => {
      responseStatus = value;
    },
  });
  (
    response as unknown as { setHeader: (k: string, v: string) => void }
  ).setHeader = () => {
    // Headers are not under assertion in these suites.
  };
  (response as unknown as { end: (data?: string) => void }).end = (
    data?: string
  ) => {
    responseBody = data ?? "";
  };

  return {
    method: options?.method ?? "POST",
    pathname: options?.pathname ?? "/api/gateway/symphony/loop",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(bodyStr),
    body: bodyStr,
    request,
    response,
    get responseStatus() {
      return responseStatus;
    },
    get responseBody() {
      return responseBody;
    },
  } as RecordingOperationContext;
}

/**
 * A dispatcher stand-in that records every route a `register*Routes` call
 * registers, plus a lookup that fails loudly on a miss.
 */
export function createRouteRecorder(): {
  dispatcher: { register: (m: string, p: string, h: OperationHandler) => void };
  routes: CapturedRoute[];
  find: (method: string, pathSubstring: string) => OperationHandler;
} {
  const routes: CapturedRoute[] = [];
  return {
    dispatcher: {
      register: (method: string, path: string, handler: OperationHandler) => {
        routes.push({ method, path, handler });
      },
    },
    routes,
    // Exact path wins over substring: "/api/gateway/symphony/loop" is a prefix
    // of the kill route, so a substring-only lookup would resolve to whichever
    // happened to register first.
    find: (method: string, pathOrSubstring: string) => {
      const candidates = routes.filter(
        (candidate) => candidate.method === method
      );
      const route =
        candidates.find((candidate) => candidate.path === pathOrSubstring) ??
        candidates.find((candidate) =>
          candidate.path.includes(pathOrSubstring)
        );
      if (!route) {
        throw new Error(
          `No handler registered for ${method} ${pathOrSubstring}`
        );
      }
      return route.handler;
    },
  };
}
