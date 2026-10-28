/**
 * ISS-11282: branch coverage for `src/server/gateway-fallback-proxy.ts` error
 * handling, driven with real `http.IncomingMessage` / `http.ServerResponse`
 * objects. Pins: a non-Error rejection's logged reason, the truncated-stream
 * arm once headers are on the wire, and the two defensive guards for a
 * response that lacks `getHeaderNames` or reports an undefined staged header.
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { proxyToFallbackGateway } from "../src/server/gateway-fallback-proxy.js";

const ORIGIN = "http://127.0.0.1:1";
const REQUEST_PATH = "/api/gateway/iss11282-fallback";
const UNREACHABLE_BODY = JSON.stringify({
  error: "fallback gateway unreachable",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  gatewayLog.clear();
});

function makeExchange(): {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  ended: () => unknown[];
} {
  const request = new http.IncomingMessage(new net.Socket());
  request.method = "GET";
  request.headers = { "x-caller": "yes" };
  const response = new http.ServerResponse(request);
  const endSpy = vi.spyOn(response, "end");
  return {
    request,
    response,
    ended: () => endSpy.mock.calls.map((call) => call[0]),
  };
}

function erroringBody(firstChunk?: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (firstChunk !== undefined && !sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(firstChunk));
        return;
      }
      controller.error(new Error("upstream reset"));
    },
  });
}

function proxy(exchange: ReturnType<typeof makeExchange>): Promise<void> {
  return proxyToFallbackGateway({
    fallbackGatewayOrigin: ORIGIN,
    rawBody: Buffer.alloc(0),
    request: exchange.request,
    requestPath: REQUEST_PATH,
    response: exchange.response,
  });
}

describe("proxyToFallbackGateway failure handling", () => {
  it("logs a non-Error rejection via String() and answers 502 with the gateway's staged headers", async () => {
    vi.stubGlobal("fetch", () => Promise.reject("ECONNREFUSED-as-string"));
    const exchange = makeExchange();
    exchange.response.setHeader("access-control-allow-origin", "https://app");

    await proxy(exchange);

    expect(exchange.response.statusCode).toBe(502);
    expect(exchange.ended()).toEqual([UNREACHABLE_BODY]);
    expect(exchange.response.getHeader("access-control-allow-origin")).toBe(
      "https://app"
    );
    expect(exchange.response.getHeader("content-type")).toBe(
      "application/json"
    );
    const entries = gatewayLog.getEntries().map((entry) => ({
      level: entry.level,
      tag: entry.tag,
      message: entry.message,
    }));
    expect(entries).toContainEqual({
      level: "warn",
      tag: "gateway-router",
      message: `fallback_gateway_unreachable path=${REQUEST_PATH} reason=ECONNREFUSED-as-string`,
    });
  });

  it("ends the truncated reply without a 502 once the upstream body has started streaming", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(erroringBody("partial"), { status: 207 }))
    );
    const exchange = makeExchange();

    await proxy(exchange);

    expect(exchange.response.headersSent).toBe(true);
    expect(exchange.response.statusCode).toBe(207);
    expect(exchange.ended()).toEqual([undefined]);
  });

  it("clears staged upstream headers before the 502 when the body fails before any write", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(erroringBody(), {
          status: 200,
          headers: { "x-upstream": "stale" },
        })
      )
    );
    const exchange = makeExchange();

    await proxy(exchange);

    expect(exchange.response.statusCode).toBe(502);
    expect(exchange.response.getHeader("x-upstream")).toBeUndefined();
    expect(exchange.ended()).toEqual([UNREACHABLE_BODY]);
  });

  it("keeps staged upstream headers when the response has no getHeaderNames accessor", async () => {
    // pins current behavior; looks odd because the 502 then carries headers
    // that described the failed upstream body. Only a non-Node response
    // object can lack the accessor.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(erroringBody(), {
          status: 200,
          headers: { "x-upstream": "stale" },
        })
      )
    );
    const exchange = makeExchange();
    Object.defineProperty(exchange.response, "getHeaderNames", {
      value: undefined,
    });

    await proxy(exchange);

    expect(exchange.response.statusCode).toBe(502);
    expect(exchange.response.getHeader("x-upstream")).toBe("stale");
    expect(exchange.ended()).toEqual([UNREACHABLE_BODY]);
  });

  it("skips a gateway-staged header whose snapshot value is undefined", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("refused")));
    const exchange = makeExchange();
    vi.spyOn(exchange.response, "getHeaders").mockReturnValue({
      "x-gateway-kept": "kept",
      "x-gateway-empty": undefined,
    });

    await proxy(exchange);

    expect(exchange.response.statusCode).toBe(502);
    expect(exchange.response.getHeader("x-gateway-kept")).toBe("kept");
    expect(exchange.response.hasHeader("x-gateway-empty")).toBe(false);
    expect(exchange.ended()).toEqual([UNREACHABLE_BODY]);
  });
});
