"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { CLOUD_RELAY_ENABLED } from "./constants";
import {
  ensureElectronDetection,
  getElectronDetectionSnapshot,
  invalidateElectronDetectionCache,
} from "./electron-detection";
import {
  ensureLocalGatewaySession,
  getLastExchangeError,
  invalidateLocalGatewaySession,
} from "./local-gateway-session";
import { getEngineerRoutingSelection } from "./routing-store";

type InterceptorWindow = Window & {
  __engineerOriginalFetch?: typeof globalThis.fetch;
  __engineerFetchInterceptorRefs?: number;
};

const ENGINEER_PREFIX = "/api/engineer/";
const ENGINEER_RELAY_PREFIX = "/api/engineer-relay/";
const LOCAL_GATEWAY_CHALLENGE_PATH = "/api/engineer/local-gateway/challenge";

function isEngineerRequest(url: URL): boolean {
  return url.pathname.startsWith(ENGINEER_PREFIX);
}

function isLocalGatewayChallengeRequest(url: URL): boolean {
  return url.pathname === LOCAL_GATEWAY_CHALLENGE_PATH;
}

function stripAuthHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("authorization");
  next.delete("cookie");
  return next;
}

function methodAllowsBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/**
 * Build a localhost-bound Request from the original request metadata and a
 * pre-materialized body buffer. The body must be materialized by the caller
 * (once) so retries can reuse the same buffer without hitting
 * "Body has already been read."
 */
function buildLocalhostRequest(
  request: Request,
  localhostUrl: URL,
  sessionToken: string | null,
  bodyBuffer: ArrayBuffer | null
): Request {
  const headers = stripAuthHeaders(request.headers);
  if (sessionToken) {
    headers.set("x-desktop-session-token", sessionToken);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    credentials: "omit",
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: "cors",
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };

  if (bodyBuffer !== null) {
    init.body = bodyBuffer;
  }

  return new Request(localhostUrl.toString(), init);
}

function withComputeTargetHeader(headers: Headers, targetId: string): Headers {
  const next = new Headers(headers);
  next.set("x-compute-target", targetId);
  return next;
}

function toRelayPath(pathname: string): string {
  return pathname.startsWith(ENGINEER_PREFIX)
    ? pathname.replace(ENGINEER_PREFIX, ENGINEER_RELAY_PREFIX)
    : pathname;
}

function createFetchInterceptor(
  originalFetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : input instanceof URL
          ? new Request(input.toString(), init)
          : new Request(
              new URL(input, globalThis.location.origin).toString(),
              init
            );
    const requestUrl = new URL(request.url, globalThis.location.origin);

    if (
      !isEngineerRequest(requestUrl) ||
      isLocalGatewayChallengeRequest(requestUrl)
    ) {
      return originalFetch(request);
    }

    const routingSelection = getEngineerRoutingSelection();

    if (
      CLOUD_RELAY_ENABLED &&
      routingSelection.mode === EngineerRoutingMode.CloudRelay &&
      routingSelection.computeTargetId
    ) {
      const rewrittenUrl = new URL(
        `${toRelayPath(requestUrl.pathname)}${requestUrl.search}`,
        globalThis.location.origin
      );
      const headers = withComputeTargetHeader(
        request.headers,
        routingSelection.computeTargetId
      );

      const init: RequestInit = {
        method: request.method,
        headers,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        signal: request.signal,
      };

      if (methodAllowsBody(request.method)) {
        init.body = await request.arrayBuffer();
      }

      return originalFetch(new Request(rewrittenUrl.toString(), init));
    }

    if (routingSelection.mode !== EngineerRoutingMode.LocalElectron) {
      return originalFetch(request);
    }

    const detectionSnapshot = getElectronDetectionSnapshot();
    const detection =
      detectionSnapshot.checkedAt === null
        ? await ensureElectronDetection()
        : detectionSnapshot;

    if (!(detection.detected && detection.port)) {
      return originalFetch(request);
    }

    const port = detection.port;
    const localhostUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      `http://localhost:${port}`
    );

    const sessionToken = await ensureLocalGatewaySession(port);

    // Short-circuit: if the session exchange failed with an actionable error
    // (e.g. missing API key → 503), return a synthetic response immediately
    // instead of sending a request that will always be rejected with a generic 401.
    if (!sessionToken) {
      const exchangeError = getLastExchangeError();
      if (exchangeError) {
        return new Response(JSON.stringify({ error: exchangeError.message }), {
          status: exchangeError.statusCode,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Materialize body once so retries can reuse the same buffer.
    const bodyBuffer = methodAllowsBody(request.method)
      ? await request.arrayBuffer()
      : null;

    const outgoing = buildLocalhostRequest(
      request,
      localhostUrl,
      sessionToken,
      bodyBuffer
    );
    try {
      const response = await originalFetch(outgoing);

      // On 401, invalidate session, re-acquire, and retry once
      if (response.status === 401 && sessionToken) {
        invalidateLocalGatewaySession();
        const freshToken = await ensureLocalGatewaySession(port);
        if (freshToken) {
          const retryUrl = new URL(
            `${requestUrl.pathname}${requestUrl.search}`,
            `http://localhost:${port}`
          );
          const retryRequest = buildLocalhostRequest(
            request,
            retryUrl,
            freshToken,
            bodyBuffer
          );
          return await originalFetch(retryRequest);
        }
      }

      return response;
    } catch (error) {
      if (error instanceof TypeError) {
        invalidateElectronDetectionCache();
        invalidateLocalGatewaySession();
      }
      throw error;
    }
  };
}

/**
 * Installs a global fetch shim for engineer routes.
 * Reference-counted to tolerate React Strict Mode remounts in development.
 */
export function installEngineerFetchInterceptor(): () => void {
  if (globalThis.window === undefined) {
    return () => {};
  }

  const interceptorWindow = globalThis.window as InterceptorWindow;

  if (!interceptorWindow.__engineerOriginalFetch) {
    interceptorWindow.__engineerOriginalFetch =
      globalThis.fetch.bind(globalThis);
    globalThis.fetch = createFetchInterceptor(
      interceptorWindow.__engineerOriginalFetch
    );
    interceptorWindow.__engineerFetchInterceptorRefs = 0;
  }

  interceptorWindow.__engineerFetchInterceptorRefs =
    (interceptorWindow.__engineerFetchInterceptorRefs ?? 0) + 1;

  return () => {
    const nextRefCount =
      (interceptorWindow.__engineerFetchInterceptorRefs ?? 1) - 1;
    interceptorWindow.__engineerFetchInterceptorRefs = nextRefCount;

    if (!(nextRefCount <= 0 && interceptorWindow.__engineerOriginalFetch)) {
      return;
    }

    globalThis.fetch = interceptorWindow.__engineerOriginalFetch;
    interceptorWindow.__engineerOriginalFetch = undefined;
    interceptorWindow.__engineerFetchInterceptorRefs = undefined;
  };
}

export function resetEngineerFetchInterceptorForTests(): void {
  if (globalThis.window === undefined) {
    return;
  }
  const interceptorWindow = globalThis.window as InterceptorWindow;
  if (interceptorWindow.__engineerOriginalFetch) {
    globalThis.fetch = interceptorWindow.__engineerOriginalFetch;
  }
  interceptorWindow.__engineerOriginalFetch = undefined;
  interceptorWindow.__engineerFetchInterceptorRefs = undefined;
}
