"use client";

import { rewriteDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import type { JsonValue } from "@repo/api/src/types/common";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { methodAllowsBody } from "@repo/shared-platform/gateway-fetch-shim";
import type { SurfaceRoutingAdapter } from "@repo/shared-platform/types";
import {
  hasEffectiveCommandSigningSupport,
  signDesktopCommand,
} from "@/lib/desktop-command-signing/command-signer";
import { getCachedComputeTargetForSigning } from "@/lib/desktop-command-signing/compute-target-signing-cache";
import {
  COMMAND_ID_HEADER,
  COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
  COMMAND_SIGNATURE_HEADER,
  COMMAND_SIGNATURE_PAYLOAD_HEADER,
  COMPUTE_TARGET_HEADER,
} from "@/lib/desktop-command-signing/constants";
import { bytesToBase64 } from "@/lib/desktop-command-signing/crypto-utils";
import {
  CLOUD_RELAY_ENABLED,
  GATEWAY_PATH_PREFIX,
  GATEWAY_RELAY_PATH_PREFIX,
} from "./constants";
import {
  ensureElectronDetection,
  getElectronDetectionSnapshot,
  invalidateElectronDetectionCache,
} from "./electron-detection";
import {
  ensureLocalGatewayApiNamespace,
  invalidateLocalGatewayApiNamespace,
} from "./local-gateway-api-namespace";
import {
  ensureLocalGatewaySession,
  getLastExchangeError,
  invalidateLocalGatewaySession,
} from "./local-gateway-session";
import { getEngineerRoutingSelection } from "./routing-store";

/**
 * The web surface's {@link SurfaceRoutingAdapter}: it owns the browser transport
 * mechanics for `/api/gateway/*` requests — CloudRelay rewrite + command signing,
 * and LocalElectron localhost dispatch (session-token exchange, API-namespace
 * rewrite, one-time 401 retry). The shared dispatch router selects this adapter
 * and calls `dispatchGatewayRequest`; the global fetch shim is now just glue that
 * routes gateway requests here (see engineer-fetch-interceptor.ts).
 *
 * Security note: this only ever rewrites to `localhost:<port>` (LocalElectron) or
 * the same-origin `/api/gateway-relay/*` forwarder (CloudRelay). It introduces no
 * new browser-accessible local-execution path; the `apps/app/proxy.ts` localhost
 * guard remains the enforcement boundary.
 */

function stripAuthHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("authorization");
  next.delete("cookie");
  return next;
}

function encodeRelayBodyForSigning(
  request: Request,
  bodyBuffer: ArrayBuffer | null
): JsonValue | undefined {
  if (bodyBuffer === null || bodyBuffer.byteLength === 0) {
    return undefined;
  }

  const contentType = request.headers.get("content-type");
  const bytes = new Uint8Array(bodyBuffer);
  const decoder = new TextDecoder();
  if (contentType?.includes("application/json")) {
    const text = decoder.decode(bytes);
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new Error("Invalid JSON body");
    }
  }

  if (
    contentType?.startsWith("text/") ||
    contentType?.includes("application/x-www-form-urlencoded")
  ) {
    return decoder.decode(bytes);
  }

  return bytesToBase64(bytes);
}

function buildExchangeErrorResponse(exchangeError: {
  message: string;
  statusCode: number;
}): Response {
  return new Response(JSON.stringify({ error: exchangeError.message }), {
    status: exchangeError.statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

function buildCommandSigningErrorResponse(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Command signing failed";
  return new Response(JSON.stringify({ error: message }), {
    status: message.includes("Invalid JSON body") ? 400 : 503,
    headers: { "Content-Type": "application/json" },
  });
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
  next.set(COMPUTE_TARGET_HEADER, targetId);
  return next;
}

function withCommandSigningHeaders(
  headers: Headers,
  signed: Awaited<ReturnType<typeof signDesktopCommand>>
): Headers {
  const next = new Headers(headers);
  next.set(COMMAND_ID_HEADER, signed.commandId);
  next.set(COMMAND_SIGNATURE_HEADER, signed.signature);
  next.set(COMMAND_SIGNATURE_PAYLOAD_HEADER, signed.signaturePayload);
  next.set(COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER, signed.publicKeyFingerprint);
  return next;
}

function toRelayPath(pathname: string): string {
  return pathname.startsWith(GATEWAY_PATH_PREFIX)
    ? pathname.replace(GATEWAY_PATH_PREFIX, GATEWAY_RELAY_PATH_PREFIX)
    : pathname;
}

/** CloudRelay branch: rewrite to the same-origin relay forwarder, attach the
 * compute-target header, and (when the target supports it) command-signing
 * headers. */
async function dispatchViaCloudRelay(
  originalFetch: typeof globalThis.fetch,
  request: Request,
  requestUrl: URL,
  computeTargetId: string
): Promise<Response> {
  const bodyBuffer = methodAllowsBody(request.method)
    ? await request.arrayBuffer()
    : null;
  const rewrittenUrl = new URL(
    `${toRelayPath(requestUrl.pathname)}${requestUrl.search}`,
    globalThis.location.origin
  );
  let headers = withComputeTargetHeader(request.headers, computeTargetId);
  const target = getCachedComputeTargetForSigning(computeTargetId);
  if (target && hasEffectiveCommandSigningSupport(target)) {
    try {
      const signed = await signDesktopCommand(
        {
          method: request.method,
          pathWithQuery: `${requestUrl.pathname}${requestUrl.search}`,
          body: encodeRelayBodyForSigning(request, bodyBuffer),
        },
        target
      );
      headers = withCommandSigningHeaders(headers, signed);
    } catch (error) {
      return buildCommandSigningErrorResponse(error);
    }
  }

  const relayInit: RequestInit = {
    method: request.method,
    headers,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
  if (bodyBuffer !== null) {
    relayInit.body = bodyBuffer;
  }

  return originalFetch(new Request(rewrittenUrl.toString(), relayInit));
}

function buildLocalhostUrl(
  requestUrl: URL,
  namespace: string | null | undefined,
  port: number
): URL {
  return new URL(
    namespace
      ? rewriteDesktopApiPath(
          `${requestUrl.pathname}${requestUrl.search}`,
          namespace
        )
      : `${requestUrl.pathname}${requestUrl.search}`,
    `http://localhost:${port}`
  );
}

/** Handle a 401 from the local gateway: invalidate the session/namespace caches,
 * re-acquire a token, and retry once. Returns the retry response (or a synthetic
 * exchange-error response), or `null` to let the caller return the original 401. */
async function retryLocalGatewayOn401(
  originalFetch: typeof globalThis.fetch,
  request: Request,
  requestUrl: URL,
  port: number,
  bodyBuffer: ArrayBuffer | null
): Promise<Response | null> {
  invalidateLocalGatewaySession();
  invalidateLocalGatewayApiNamespace(port);
  const freshToken = await ensureLocalGatewaySession(port);
  if (freshToken) {
    const freshNamespace = await ensureLocalGatewayApiNamespace(
      port,
      freshToken
    );
    const retryRequest = buildLocalhostRequest(
      request,
      buildLocalhostUrl(requestUrl, freshNamespace, port),
      freshToken,
      bodyBuffer
    );
    return await originalFetch(retryRequest);
  }

  const exchangeError = getLastExchangeError();
  if (exchangeError) {
    return buildExchangeErrorResponse(exchangeError);
  }
  return null;
}

/** LocalElectron branch: dispatch to the detected localhost gateway with a
 * session token + API-namespace rewrite, retrying once on 401. */
async function dispatchViaLocalElectron(
  originalFetch: typeof globalThis.fetch,
  request: Request,
  requestUrl: URL
): Promise<Response> {
  const detectionSnapshot = getElectronDetectionSnapshot();
  const detection =
    detectionSnapshot.checkedAt === null
      ? await ensureElectronDetection()
      : detectionSnapshot;

  if (!(detection.detected && detection.port)) {
    return originalFetch(request);
  }

  const port = detection.port;
  const sessionToken = await ensureLocalGatewaySession(port);

  // Short-circuit: if the session exchange failed with an actionable error
  // (e.g. missing API key → 503), return a synthetic response immediately
  // instead of sending a request that will always be rejected with a generic 401.
  if (!sessionToken) {
    const exchangeError = getLastExchangeError();
    if (exchangeError) {
      return buildExchangeErrorResponse(exchangeError);
    }
  }

  const namespace = await ensureLocalGatewayApiNamespace(port, sessionToken);
  const localhostUrl = buildLocalhostUrl(requestUrl, namespace, port);

  // Materialize body once so the 401 retry can reuse the same buffer.
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

    if (response.status === 401 && sessionToken) {
      const retried = await retryLocalGatewayOn401(
        originalFetch,
        request,
        requestUrl,
        port,
        bodyBuffer
      );
      if (retried) {
        return retried;
      }
    }

    return response;
  } catch (error) {
    if (error instanceof TypeError) {
      invalidateElectronDetectionCache();
      invalidateLocalGatewaySession();
      invalidateLocalGatewayApiNamespace(port);
    }
    throw error;
  }
}

function dispatchWebGatewayRequest(
  originalFetch: typeof globalThis.fetch,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(path, init);
  const requestUrl = new URL(request.url, globalThis.location.origin);
  const routingSelection = getEngineerRoutingSelection();

  if (
    CLOUD_RELAY_ENABLED &&
    routingSelection.mode === EngineerRoutingMode.CloudRelay &&
    routingSelection.computeTargetId
  ) {
    return dispatchViaCloudRelay(
      originalFetch,
      request,
      requestUrl,
      routingSelection.computeTargetId
    );
  }

  if (routingSelection.mode !== EngineerRoutingMode.LocalElectron) {
    return originalFetch(request);
  }

  return dispatchViaLocalElectron(originalFetch, request, requestUrl);
}

/**
 * Create the web surface routing adapter. `originalFetch` is the un-intercepted
 * browser fetch (captured by the interceptor install) used to perform the actual
 * network calls.
 */
export function createWebSurfaceRoutingAdapter(
  originalFetch: typeof globalThis.fetch
): SurfaceRoutingAdapter {
  return {
    surfaceName: "web",
    dispatchGatewayRequest: (path, init) =>
      dispatchWebGatewayRequest(originalFetch, path, init),
    supportsMode: (mode) =>
      mode === EngineerRoutingMode.CloudRelay ||
      mode === EngineerRoutingMode.LocalElectron,
  };
}
