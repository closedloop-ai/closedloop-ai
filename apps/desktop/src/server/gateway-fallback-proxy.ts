import type { IncomingMessage, ServerResponse } from "node:http";
import { gatewayLog } from "../main/logging/gateway-logger.js";

/**
 * The gateway's last-resort proxy: forward an otherwise-unrouted request to
 * `fallbackGatewayOrigin`, split out of `router.ts` (ISS-8234).
 *
 * Separate module because that file is over the 1,000-line ceiling and
 * shrink-only, and "forward one request upstream and stream the reply back" is
 * a separable responsibility from "decide which handler owns this path". The
 * router keeps the routing decision and the auth gate that precedes it; only
 * the forwarding moves.
 *
 * Reached ONLY after `GatewayRouter.handle` has run its auth gate and found no
 * registered operation, and only when `fallbackGatewayOrigin` is set — which is
 * `process.env.SYMPHONY_GATEWAY_FALLBACK_ORIGIN`, unset in every shipped build.
 * This is a developer-environment path.
 */
export async function proxyToFallbackGateway(options: {
  fallbackGatewayOrigin: string;
  rawBody: Buffer;
  request: IncomingMessage;
  requestPath: string;
  response: ServerResponse;
}): Promise<void> {
  const { fallbackGatewayOrigin, rawBody, request, requestPath, response } =
    options;
  // Whatever `GatewayRouter.handle` staged before delegating here — today the
  // CORS headers from `applyCorsHeaders`, which a cross-origin caller needs in
  // order to READ our reply at all. Captured before the first upstream header
  // lands, so the error path below can tell the gateway's own headers (keep)
  // from the upstream's (drop) without knowing either set by name.
  const gatewayOwnedHeaders = Object.entries(response.getHeaders());
  try {
    const targetUrl = new URL(requestPath, fallbackGatewayOrigin);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!value) {
        continue;
      }
      if (name.toLowerCase() === "host") {
        continue;
      }
      if (Array.isArray(value)) {
        headers.set(name, value.join(", "));
      } else {
        headers.set(name, value);
      }
    }

    const method = request.method?.toUpperCase() ?? "GET";
    const upstreamResponse = await fetch(targetUrl, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : new Uint8Array(rawBody),
    });

    response.statusCode = upstreamResponse.status;
    for (const [name, value] of upstreamResponse.headers) {
      if (name.toLowerCase() === "access-control-allow-origin") {
        continue;
      }
      response.setHeader(name, value);
    }

    if (!upstreamResponse.body) {
      response.end();
      return;
    }

    const reader = upstreamResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      response.write(Buffer.from(value));
    }
    response.end();
  } catch (error) {
    respondFallbackUnreachable(
      response,
      requestPath,
      error,
      gatewayOwnedHeaders
    );
  }
}

/**
 * A fallback that cannot be reached is a 502, never a process exit.
 *
 * `server.ts` dispatches with a bare `void this.router.handle(...)`, so before
 * ISS-8234 a rejection here — a malformed origin reaching `new URL`, or an
 * `ECONNREFUSED` from a fallback nobody started — surfaced as an unhandled
 * rejection and `handleUnhandledRejection` quit the whole Electron app, giving
 * the developer no error at all.
 *
 * Once the upstream reply has started streaming the status line is already on
 * the wire, so the only honest move left is to end the truncated response
 * rather than write a second, contradictory one.
 */
function respondFallbackUnreachable(
  response: ServerResponse,
  requestPath: string,
  error: unknown,
  gatewayOwnedHeaders: [string, number | string | string[] | undefined][]
): void {
  const reason = error instanceof Error ? error.message : String(error);
  gatewayLog.warn(
    "gateway-router",
    `fallback_gateway_unreachable path=${requestPath} reason=${reason}`
  );
  if (response.headersSent) {
    response.end();
    return;
  }
  // The upstream's headers may already be staged from a reply whose BODY then
  // failed mid-read. Clearing them is what makes the 502 writable: a staged
  // `content-length` describing the upstream body would make `end()` below
  // throw ERR_HTTP_CONTENT_LENGTH_MISMATCH — another unhandled rejection, which
  // is the exact failure this handler exists to prevent.
  for (const name of response.getHeaderNames?.() ?? []) {
    response.removeHeader(name);
  }
  // Restoring the gateway's own headers is what makes this 502 legible to the
  // caller: the renderer reaches the gateway cross-origin, so a reply stripped
  // of `Access-Control-Allow-Origin` is not a readable JSON error but a generic
  // browser CORS failure — the honest status replaced by no status at all.
  for (const [name, value] of gatewayOwnedHeaders) {
    if (value !== undefined) {
      response.setHeader(name, value);
    }
  }
  response.statusCode = 502;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: "fallback gateway unreachable" }));
}
