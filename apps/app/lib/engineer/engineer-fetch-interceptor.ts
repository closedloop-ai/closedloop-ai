"use client";

import {
  ensureElectronDetection,
  getElectronDetectionSnapshot,
} from "./electron-detection";
import { getEngineerRoutingSelection } from "./routing-store";

type InterceptorWindow = Window & {
  __engineerOriginalFetch?: typeof globalThis.fetch;
  __engineerFetchInterceptorRefs?: number;
};

const ENGINEER_PREFIX = "/api/engineer/";
const ENGINEER_RELAY_PREFIX = "/api/engineer-relay/";

function isEngineerRequest(url: URL): boolean {
  return url.pathname.startsWith(ENGINEER_PREFIX);
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

async function buildLocalhostRequest(
  request: Request,
  localhostUrl: URL
): Promise<Request> {
  const headers = stripAuthHeaders(request.headers);

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

  if (methodAllowsBody(request.method)) {
    // Materialize body once to avoid stream cloning edge-cases across rewrites.
    init.body = await request.arrayBuffer();
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

    if (!isEngineerRequest(requestUrl)) {
      return originalFetch(request);
    }

    const routingSelection = getEngineerRoutingSelection();

    if (
      routingSelection.mode === "cloud-relay" &&
      routingSelection.computeTargetId
    ) {
      const rewrittenUrl = new URL(
        `${toRelayPath(requestUrl.pathname)}${requestUrl.search}`,
        globalThis.location.origin
      );
      const rewrittenRequest = new Request(rewrittenUrl.toString(), request);
      const headers = withComputeTargetHeader(
        rewrittenRequest.headers,
        routingSelection.computeTargetId
      );

      const outgoing = new Request(rewrittenRequest, { headers });
      return originalFetch(outgoing);
    }

    if (routingSelection.mode !== "local-electron") {
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

    const localhostUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      `http://localhost:${detection.port}`
    );

    const outgoing = await buildLocalhostRequest(request, localhostUrl);
    return originalFetch(outgoing);
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
