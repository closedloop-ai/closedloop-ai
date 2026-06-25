/**
 * Surface-neutral gateway fetch shim.
 *
 * Installs a global `fetch` wrapper that intercepts `/api/gateway/*` requests
 * and routes them through the shared dispatch router (`dispatchGatewayRequest`),
 * which selects the registered `SurfaceRoutingAdapter` for the active routing
 * mode. Every non-gateway request passes straight through to the original
 * (un-intercepted) fetch.
 *
 * This is the single source of truth for the fetch-interception mechanics shared
 * by every surface that owns a browser-like `globalThis.fetch` — the Next.js web
 * shell (`apps/app`) and the Electron desktop renderer (`apps/desktop`).
 * Surface-specific transport lives in each surface's `SurfaceRoutingAdapter`,
 * NOT here: this shim only matches gateway requests and delegates.
 *
 * SECURITY: the shim introduces no new local-execution path. It forwards matched
 * requests to the registered adapter only; the adapter (web) / main-process IPC
 * handler (desktop) remains the enforcement boundary.
 */

import { GATEWAY_PATH_PREFIX } from "./gateway-constants";
import { dispatchGatewayRequest } from "./gateway-dispatch";

/**
 * Window-scoped install state. Keyed on the global so a single shim is shared
 * across every caller in the same renderer (web bootstrap, desktop provider),
 * and ref-counted so React Strict Mode mount/unmount/remount cycles never leave
 * a dangling wrapper or double-install.
 */
type GatewayFetchShimGlobal = typeof globalThis & {
  __gatewayFetchShimOriginalFetch?: typeof globalThis.fetch;
  __gatewayFetchShimRefs?: number;
};

/** Whether a request to this URL targets a gateway route. */
export function isGatewayRequest(url: URL): boolean {
  return url.pathname.startsWith(GATEWAY_PATH_PREFIX);
}

/** GET/HEAD carry no body; every other method may. */
export function methodAllowsBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/**
 * Forwardable RequestInit derived from a normalized Request, with the body
 * materialized once so the shared router / surface adapter can reconstruct an
 * equivalent Request (and reuse the buffer across retries) without hitting
 * "Body has already been read." `mode` is intentionally omitted — the adapter
 * sets the transport-appropriate mode itself.
 */
function toForwardableInit(
  request: Request,
  bodyBuffer: ArrayBuffer | null
): RequestInit {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    credentials: request.credentials,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
  if (bodyBuffer !== null) {
    init.body = bodyBuffer;
  }
  return init;
}

/**
 * A global `fetch` shim that delegates `/api/gateway/*` requests to the shared
 * dispatch router (which selects the registered `SurfaceRoutingAdapter`) and
 * passes everything else straight through to `originalFetch`. All
 * surface-specific routing mechanics live in the adapter, not here.
 */
export function createFetchInterceptor(
  originalFetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let request: Request;
    if (input instanceof Request) {
      request = new Request(input, init);
    } else if (input instanceof URL) {
      request = new Request(input.toString(), init);
    } else {
      request = new Request(
        new URL(input, globalThis.location.origin).toString(),
        init
      );
    }
    const requestUrl = new URL(request.url, globalThis.location.origin);

    if (!isGatewayRequest(requestUrl)) {
      return originalFetch(request);
    }

    // Materialize the body once at the boundary so the adapter can rebuild an
    // equivalent request (and retry) without re-reading a consumed stream.
    const bodyBuffer = methodAllowsBody(request.method)
      ? await request.arrayBuffer()
      : null;

    return dispatchGatewayRequest(
      request.url,
      toForwardableInit(request, bodyBuffer)
    );
  };
}

export type GatewayFetchShimHandle = {
  /**
   * The captured, un-intercepted `fetch`. Surface adapters MUST perform their
   * own network calls through this reference so adapter traffic never re-enters
   * the shim (which would cause an infinite dispatch loop).
   */
  readonly originalFetch: typeof globalThis.fetch;
  /** True only for the install that actually replaced `globalThis.fetch`. */
  readonly isFirstInstall: boolean;
  /**
   * Decrement the ref count. Returns `true` if this call fully uninstalled the
   * shim (restored the original `globalThis.fetch`), so the caller can tear down
   * the surface adapter it registered on first install.
   */
  dispose: () => boolean;
};

/**
 * Install the surface-neutral gateway fetch shim. Ref-counted and idempotent:
 * the first call replaces `globalThis.fetch`; subsequent calls reuse the same
 * captured `originalFetch` and bump the ref count. Outside a browser
 * (`window === undefined`) it is a no-op that returns the current fetch.
 *
 * The shim does NOT register any `SurfaceRoutingAdapter` — that is the caller's
 * responsibility (web bootstrap registers the web adapter, the desktop provider
 * the desktop adapter), so the same shim serves every surface.
 */
export function installGatewayFetchShim(): GatewayFetchShimHandle {
  if (globalThis.window === undefined) {
    return {
      originalFetch: globalThis.fetch,
      isFirstInstall: false,
      dispose: () => false,
    };
  }

  const shimGlobal = globalThis as GatewayFetchShimGlobal;
  let isFirstInstall = false;

  if (!shimGlobal.__gatewayFetchShimOriginalFetch) {
    const originalFetch = globalThis.fetch.bind(globalThis);
    shimGlobal.__gatewayFetchShimOriginalFetch = originalFetch;
    globalThis.fetch = createFetchInterceptor(originalFetch);
    shimGlobal.__gatewayFetchShimRefs = 0;
    isFirstInstall = true;
  }

  shimGlobal.__gatewayFetchShimRefs =
    (shimGlobal.__gatewayFetchShimRefs ?? 0) + 1;
  const originalFetch = shimGlobal.__gatewayFetchShimOriginalFetch;

  return {
    originalFetch,
    isFirstInstall,
    dispose: () => {
      const nextRefCount = (shimGlobal.__gatewayFetchShimRefs ?? 1) - 1;
      shimGlobal.__gatewayFetchShimRefs = nextRefCount;

      if (!(nextRefCount <= 0 && shimGlobal.__gatewayFetchShimOriginalFetch)) {
        return false;
      }

      globalThis.fetch = shimGlobal.__gatewayFetchShimOriginalFetch;
      shimGlobal.__gatewayFetchShimOriginalFetch = undefined;
      shimGlobal.__gatewayFetchShimRefs = undefined;
      return true;
    },
  };
}

/** Test-only: force-restore the original fetch and clear shim install state. */
export function resetGatewayFetchShimForTests(): void {
  if (globalThis.window === undefined) {
    return;
  }
  const shimGlobal = globalThis as GatewayFetchShimGlobal;
  if (shimGlobal.__gatewayFetchShimOriginalFetch) {
    globalThis.fetch = shimGlobal.__gatewayFetchShimOriginalFetch;
  }
  shimGlobal.__gatewayFetchShimOriginalFetch = undefined;
  shimGlobal.__gatewayFetchShimRefs = undefined;
}
