"use client";

import {
  registerSurfaceRoutingAdapter,
  resetRoutingAdaptersForTests,
} from "@repo/shared-platform/gateway-dispatch";
import {
  installGatewayFetchShim,
  resetGatewayFetchShimForTests,
} from "@repo/shared-platform/gateway-fetch-shim";
import { invalidateLocalGatewayApiNamespace } from "./local-gateway-api-namespace";
import { createWebSurfaceRoutingAdapter } from "./web-surface-routing-adapter";

type InterceptorWindow = Window & {
  __engineerOriginalFetch?: typeof globalThis.fetch;
  __engineerRoutingAdapterDispose?: () => void;
};

/**
 * Installs the global gateway fetch shim (shared, surface-neutral) and registers
 * the web `SurfaceRoutingAdapter` the shared router dispatches to.
 *
 * The shim is ref-counted to tolerate React Strict Mode remounts; the web
 * adapter is registered exactly once (on the shim's first install) and torn down
 * only when the shim fully uninstalls. The adapter is created with the shim's
 * captured, un-intercepted `originalFetch` so its own network calls never
 * re-enter the shim (which would loop infinitely).
 *
 * The captured `originalFetch` is also published under the historical
 * `window.__engineerOriginalFetch` key that `getRawFetch()`
 * (local-gateway-api-namespace.ts) reads. Without it, the `/api/gateway/version`
 * namespace probe — whose purpose is to BYPASS the interceptor — would fall back
 * to the shim-intercepted `globalThis.fetch`, match the gateway prefix, re-enter
 * dispatch, and self-await `ensureLocalGatewayApiNamespace`'s in-flight promise
 * (a deadlock that stalls every LocalElectron gateway dispatch).
 */
export function installEngineerFetchInterceptor(): () => void {
  if (globalThis.window === undefined) {
    return () => {};
  }

  const interceptorWindow = globalThis.window as InterceptorWindow;
  const shim = installGatewayFetchShim();

  if (shim.isFirstInstall) {
    interceptorWindow.__engineerOriginalFetch = shim.originalFetch;
    interceptorWindow.__engineerRoutingAdapterDispose =
      registerSurfaceRoutingAdapter(
        createWebSurfaceRoutingAdapter(shim.originalFetch)
      );
  }

  return () => {
    const uninstalled = shim.dispose();
    if (uninstalled) {
      interceptorWindow.__engineerRoutingAdapterDispose?.();
      interceptorWindow.__engineerRoutingAdapterDispose = undefined;
      interceptorWindow.__engineerOriginalFetch = undefined;
    }
  };
}

export function resetEngineerFetchInterceptorForTests(): void {
  if (globalThis.window === undefined) {
    return;
  }
  invalidateLocalGatewayApiNamespace();
  const interceptorWindow = globalThis.window as InterceptorWindow;
  interceptorWindow.__engineerRoutingAdapterDispose?.();
  interceptorWindow.__engineerRoutingAdapterDispose = undefined;
  interceptorWindow.__engineerOriginalFetch = undefined;
  resetRoutingAdaptersForTests();
  resetGatewayFetchShimForTests();
}
