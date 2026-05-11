"use client";

import { rewriteDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import type { JsonValue } from "@repo/api/src/types/common";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import {
  hasEffectiveCommandSigningSupport,
  signDesktopCommand,
} from "@/lib/crypto/command-signer";
import { bytesToBase64 } from "@/lib/crypto/crypto-utils";
import { getCachedComputeTargetForSigning } from "@/lib/engineer/compute-target-signing-cache";
import {
  CLOUD_RELAY_ENABLED,
  COMMAND_ID_HEADER,
  COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
  COMMAND_SIGNATURE_HEADER,
  COMMAND_SIGNATURE_PAYLOAD_HEADER,
  COMPUTE_TARGET_HEADER,
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

type InterceptorWindow = Window & {
  __engineerOriginalFetch?: typeof globalThis.fetch;
  __engineerFetchInterceptorRefs?: number;
};

function isGatewayRequest(url: URL): boolean {
  return url.pathname.startsWith(GATEWAY_PATH_PREFIX);
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
    return decoder.decode(bytes) as unknown as JsonValue;
  }

  return bytesToBase64(bytes) as unknown as JsonValue;
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

function createFetchInterceptor(
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

    const routingSelection = getEngineerRoutingSelection();

    if (
      CLOUD_RELAY_ENABLED &&
      routingSelection.mode === EngineerRoutingMode.CloudRelay &&
      routingSelection.computeTargetId
    ) {
      const bodyBuffer = methodAllowsBody(request.method)
        ? await request.arrayBuffer()
        : null;
      const rewrittenUrl = new URL(
        `${toRelayPath(requestUrl.pathname)}${requestUrl.search}`,
        globalThis.location.origin
      );
      let headers = withComputeTargetHeader(
        request.headers,
        routingSelection.computeTargetId
      );
      const target = getCachedComputeTargetForSigning(
        routingSelection.computeTargetId
      );
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

      if (bodyBuffer !== null) {
        init.body = bodyBuffer;
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
    const localhostUrl = new URL(
      namespace
        ? rewriteDesktopApiPath(
            `${requestUrl.pathname}${requestUrl.search}`,
            namespace
          )
        : `${requestUrl.pathname}${requestUrl.search}`,
      `http://localhost:${port}`
    );

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
        invalidateLocalGatewayApiNamespace(port);
        const freshToken = await ensureLocalGatewaySession(port);
        if (freshToken) {
          const freshNamespace = await ensureLocalGatewayApiNamespace(
            port,
            freshToken
          );
          const retryUrl = new URL(
            freshNamespace
              ? rewriteDesktopApiPath(
                  `${requestUrl.pathname}${requestUrl.search}`,
                  freshNamespace
                )
              : `${requestUrl.pathname}${requestUrl.search}`,
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

        const exchangeError = getLastExchangeError();
        if (exchangeError) {
          return buildExchangeErrorResponse(exchangeError);
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
  };
}

/**
 * Installs a global fetch shim for gateway routes.
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
  invalidateLocalGatewayApiNamespace();
  const interceptorWindow = globalThis.window as InterceptorWindow;
  if (interceptorWindow.__engineerOriginalFetch) {
    globalThis.fetch = interceptorWindow.__engineerOriginalFetch;
  }
  interceptorWindow.__engineerOriginalFetch = undefined;
  interceptorWindow.__engineerFetchInterceptorRefs = undefined;
}
