/**
 * ISS-5299 — Gateway router plumbing tests.
 *
 * Covers routing fallthrough, the fallback proxy, and the header/auth helpers
 * in apps/desktop/src/server/router.ts. Lives as a sibling of
 * gateway-server.test.ts because that file is on the shrink-only
 * noExcessiveLinesPerFile grandfather list in biome.jsonc and must not grow.
 *
 * SECURITY CRITICAL: tests include the loopback-only exchange guard (lines
 * 1236/1241) and the timing-safe token length-mismatch path (line 1229).
 */
import assert from "node:assert/strict";
import type http from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { MEMBER_PACK_INSTALL_PATH } from "@repo/api/src/types/member-pack-install.js";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { GatewayRouter } from "../src/server/router.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  dispatchMockRequest,
  TestResponse,
} from "./gateway-server-test-doubles.js";

// ---------------------------------------------------------------------------
// Module-level cleanup
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRouter(
  overrides: Partial<ConstructorParameters<typeof GatewayRouter>[0]> = {}
): GatewayRouter {
  return new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "plumbing-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    schedulers: new LoopSchedulerContext(),
    ...overrides,
  });
}

/**
 * Calls router.handle() with a manually-crafted IncomingMessage. Unlike
 * dispatchMockRequest, callers may omit method or url to exercise the
 * `?? "GET"` (line 498) and `?? "/"` (line 499) fallbacks in router.ts.
 */
async function driveRouter(
  router: GatewayRouter,
  opts: {
    method?: string;
    url?: string;
    headers?: http.IncomingHttpHeaders;
    remoteAddress?: string;
    chunks?: (Buffer | string)[];
  }
): Promise<TestResponse> {
  const stream = Readable.from(opts.chunks ?? []) as Readable & {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  // Deliberately skip setting method/url when the caller omits them so the
  // production `?? "GET"` / `?? "/"` defaults are exercised at runtime.
  if (opts.method !== undefined) {
    stream.method = opts.method;
  }
  if (opts.url !== undefined) {
    stream.url = opts.url;
  }
  stream.headers = opts.headers ?? {};
  stream.socket = { remoteAddress: opts.remoteAddress };

  const response = new TestResponse();
  // Cast via unknown: Readable with http-like fields is structurally compatible
  // with IncomingMessage for what router.handle() reads from it.
  await router.handle(
    stream as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse
  );
  if (!response.finished) {
    await new Promise<void>((resolve) => response.once("finish", resolve));
  }
  return response;
}

/** A gateway path with no registered handler — falls through to proxy or 501. */
const UNREGISTERED_GATEWAY_PATH = "/api/gateway/iss5299-plumbing-test";
const FALLBACK_ORIGIN = "https://fallback.example.com";

// ---------------------------------------------------------------------------
// Routing fallthrough  (lines 498, 499, 667)
// ---------------------------------------------------------------------------

test("non-gateway non-health path returns 404 route-not-found JSON", async () => {
  const router = createRouter();
  const response = await dispatchMockRequest({
    router,
    method: "GET",
    path: "/totally-unknown-path",
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "route not found" });
});

test("undefined request method defaults to GET and undefined url defaults to /", async () => {
  // Omitting both method and url exercises the `?? "GET"` (line 498) and
  // `?? "/"` (line 499) fallbacks. The resolved path "/" is not a gateway or
  // health route, so the router falls through to the 404 handler (line 667).
  const router = createRouter();
  const response = await driveRouter(router, {});
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "route not found" });
});

// ---------------------------------------------------------------------------
// Constructor conditional registration  (lines 469, 472, 484)
// ---------------------------------------------------------------------------

test("update-and-restart routes are registered when all three update options are provided", async () => {
  // Without the optional functions the route is not registered → generic 501.
  const withoutUpdate = createRouter();
  const r1 = await dispatchMockRequest({
    router: withoutUpdate,
    method: "POST",
    path: "/api/gateway/update-and-restart",
  });
  assert.equal(r1.statusCode, 501);
  assert.equal(
    r1.json().error,
    "operation not implemented",
    "unregistered route returns the generic 501 body"
  );

  // With all three options present (true branches at lines 469/472) the route
  // IS registered. isUpdateAndRestartEnabled returns false so the handler runs
  // its own 501 with a different, non-generic error body — proving the route
  // handler executed rather than the generic unregistered-route fallback.
  const withUpdate = createRouter({
    checkForUpdate: async () => ({ updateAvailable: false }),
    applyUpdate: async () => {},
    isUpdateAndRestartEnabled: () => false,
  });
  const r2 = await dispatchMockRequest({
    router: withUpdate,
    method: "POST",
    path: "/api/gateway/update-and-restart",
  });
  assert.equal(r2.statusCode, 501);
  assert.equal(
    r2.json().error,
    "feature_disabled",
    "registered but feature-disabled route returns its own body, not the generic one"
  );
});

test("pack-install route is registered when installPack option is provided", async () => {
  // Without installPack (line 484 false branch): route not registered → 501.
  const withoutPack = createRouter();
  const r1 = await dispatchMockRequest({
    router: withoutPack,
    method: "POST",
    path: MEMBER_PACK_INSTALL_PATH,
    chunks: [JSON.stringify({ packId: "p", harness: "claude" })],
  });
  assert.equal(r1.statusCode, 501);
  assert.equal(r1.json().error, "operation not implemented");

  // With installPack (line 484 true branch): route is registered and the
  // handler calls installPack then returns 202 Accepted.
  const withPack = createRouter({
    installPack: async (_packId, _harness) => ({ started: true, runId: 42 }),
  });
  const r2 = await dispatchMockRequest({
    router: withPack,
    method: "POST",
    path: MEMBER_PACK_INSTALL_PATH,
    chunks: [JSON.stringify({ packId: "my-pack", harness: "claude" })],
  });
  assert.equal(r2.statusCode, 202);
  const body2 = r2.json();
  assert.equal(body2.accepted, true);
  assert.equal(body2.packId, "my-pack");
  assert.equal(body2.runId, 42);
});

// ---------------------------------------------------------------------------
// Proxy fallback  (lines 1081, 1087, 1094, 1099, 1100, 1106, 1112)
// ---------------------------------------------------------------------------

test("proxy skips falsy headers and always strips the host header", async () => {
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });

  let capturedHeaders: Headers | undefined;
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    // init.headers is the Headers instance built inside proxyToFallback.
    capturedHeaders = init?.headers as Headers;
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof globalThis.fetch;

  await dispatchMockRequest({
    router,
    method: "GET",
    path: UNREGISTERED_GATEWAY_PATH,
    headers: {
      host: "localhost:3000",
      "x-present": "present-value",
      // Falsy (undefined) value → skipped by the `if (!value) continue` at
      // line 1081 of router.ts.
      "x-falsy-header": undefined,
    },
  });

  assert.ok(capturedHeaders, "fetch must have been called");
  assert.ok(
    !capturedHeaders.has("host"),
    "host header must be stripped from the proxied request"
  );
  assert.ok(
    !capturedHeaders.has("x-falsy-header"),
    "falsy header must be skipped (line 1081)"
  );
  assert.equal(capturedHeaders.get("x-present"), "present-value");
});

test("proxy joins array-valued headers with ', ' separator", async () => {
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });

  let capturedHeaders: Headers | undefined;
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = init?.headers as Headers;
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof globalThis.fetch;

  await dispatchMockRequest({
    router,
    method: "GET",
    path: UNREGISTERED_GATEWAY_PATH,
    headers: {
      // Node.js can provide string[] for multi-value headers; the proxy must
      // join them (line 1087) rather than passing the raw array to fetch.
      "x-multi": ["first", "second", "third"],
    },
  });

  assert.ok(capturedHeaders, "fetch must have been called");
  assert.equal(
    capturedHeaders.get("x-multi"),
    "first, second, third",
    "array header must be joined with ', ' (line 1087)"
  );
});

test("proxy falls back to GET when request method is undefined and sends no body", async () => {
  // Leaving method undefined exercises the ?? "GET" fallback at both
  // line 498 (handle) and line 1094 (proxyToFallback). The GET path then
  // takes the `? undefined` branch at lines 1099/1100.
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });

  let capturedMethod: string | undefined;
  let capturedBody: RequestInit["body"] | undefined;
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    capturedMethod = init?.method;
    capturedBody = init?.body;
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof globalThis.fetch;

  const response = await driveRouter(router, {
    url: UNREGISTERED_GATEWAY_PATH,
    headers: { origin: "https://app.closedloop.ai" },
    // method intentionally omitted → exercises the ?? "GET" fallback
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    capturedMethod,
    "GET",
    "proxy must forward the GET default method"
  );
  assert.strictEqual(
    capturedBody,
    undefined,
    "GET must not send a body to the upstream (lines 1099/1100)"
  );
});

test("proxy forwards request body as Uint8Array for non-GET methods", async () => {
  // The `new Uint8Array(rawBody)` at line 1100 (false branch of GET/HEAD ternary)
  // is reached for POST requests.
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });

  let capturedBody: RequestInit["body"] | undefined;
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = init?.body;
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof globalThis.fetch;

  const payload = JSON.stringify({ action: "test-forward" });
  await dispatchMockRequest({
    router,
    method: "POST",
    path: UNREGISTERED_GATEWAY_PATH,
    chunks: [payload],
  });

  // The proxy creates new Uint8Array(rawBody) for non-GET/HEAD (line 1100).
  assert.ok(
    capturedBody instanceof Uint8Array,
    "POST body must be forwarded as Uint8Array"
  );
  assert.equal(
    // Uint8Array is the runtime type; cast needed because TypeScript types body
    // as BodyInit which includes ArrayBufferView but not Uint8Array directly.
    Buffer.from(capturedBody as Uint8Array).toString("utf8"),
    payload
  );
});

test("proxy strips access-control-allow-origin from upstream response headers", async () => {
  // The `if (name.toLowerCase() === "access-control-allow-origin") continue`
  // at line 1106 prevents the upstream CORS header from being echoed back
  // (the router sets its own CORS headers via applyCorsHeaders).
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, {
        status: 200,
        headers: {
          "x-upstream-custom": "preserved",
          "access-control-allow-origin": "must-be-stripped",
        },
      })
    )) as typeof globalThis.fetch;

  const response = await dispatchMockRequest({
    router,
    method: "GET",
    path: UNREGISTERED_GATEWAY_PATH,
  });

  assert.equal(response.statusCode, 200);
  // applyCorsHeaders (line 496) always sets access-control-allow-origin to the
  // router's own policy value before any routing. Line 1106 in proxyToFallback
  // then skips the upstream copy of this header so the upstream's value is
  // never forwarded. The observable proof: the response header has the router's
  // own value ("https://app.closedloop.ai"), not "must-be-stripped".
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai",
    "header must contain the router CORS value, not the upstream value (line 1106)"
  );
  assert.equal(
    response.headers.get("x-upstream-custom"),
    "preserved",
    "non-CORS upstream headers must be forwarded"
  );
});

test("proxy ends response immediately when upstream has no body", async () => {
  // A plain object with body: null simulates a null-body upstream response,
  // triggering the `if (!upstreamResponse.body)` early-return at line 1112.
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });

  globalThis.fetch = (() =>
    Promise.resolve({
      status: 204,
      headers: new Headers(),
      body: null,
    } as unknown as Response)) as typeof globalThis.fetch;

  const response = await dispatchMockRequest({
    router,
    method: "GET",
    path: UNREGISTERED_GATEWAY_PATH,
  });

  assert.equal(response.statusCode, 204);
  assert.equal(
    response.chunks.length,
    0,
    "no body chunks should be written when upstream body is null"
  );
  assert.ok(
    response.finished,
    "response must be finished after the no-body end()"
  );
});

// ---------------------------------------------------------------------------
// Header helpers  (lines 1133, 1144)
// ---------------------------------------------------------------------------

test("firstHeaderValue returns first element when header value is an array", async () => {
  // x-desktop-source is fed to evaluateApproval via firstHeaderValue().
  // Passing an array exercises the Array.isArray branch (line 1133).
  let capturedSource: string | null | undefined;
  const router = createRouter({
    evaluateApproval: (req) => {
      capturedSource = req.source;
      return { allow: true };
    },
  });

  await dispatchMockRequest({
    router,
    method: "POST",
    path: UNREGISTERED_GATEWAY_PATH,
    headers: {
      // Node.js IncomingHttpHeaders allows string[] for arbitrary header keys.
      "x-desktop-source": ["primary-source", "secondary"],
    },
  });

  assert.equal(
    capturedSource,
    "primary-source",
    "firstHeaderValue must return the first element of an array (line 1133)"
  );
});

test("parseBooleanHeader returns true for '1' and case-insensitive 'true', false otherwise", async () => {
  // x-desktop-force-approval is processed by parseBooleanHeader(), which is
  // called at line 1144. True values "1", "true", "TRUE" and false values
  // "garbage", "0" all exercise that return statement.
  const capturedValues: boolean[] = [];
  const router = createRouter({
    evaluateApproval: (req) => {
      capturedValues.push(req.forceApproval);
      return { allow: true };
    },
  });

  for (const headerValue of ["1", "true", "TRUE", "garbage", "0"]) {
    await dispatchMockRequest({
      router,
      method: "POST",
      path: UNREGISTERED_GATEWAY_PATH,
      headers: { "x-desktop-force-approval": headerValue },
    });
  }

  // "1"→true, "true"→true, "TRUE"→true (line 1144 true branch),
  // "garbage"→false, "0"→false.
  assert.deepEqual(capturedValues, [true, true, true, false, false]);
});

// ---------------------------------------------------------------------------
// Content-length handling  (lines 1198, 1204)
// ---------------------------------------------------------------------------

test("valid numeric content-length header enters BigInt parse path without rejecting", async () => {
  // content-length "50" is below the 256 KiB generic limit. BigInt("50") is
  // computed at line 1198 but does not exceed the cap, so no 413 is thrown.
  // The request proceeds to dispatch and gets 501 (no handler registered).
  const router = createRouter();
  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: UNREGISTERED_GATEWAY_PATH,
    headers: { "content-length": "50" },
    chunks: ["{}"],
  });
  assert.equal(response.statusCode, 501);
  const body = response.json();
  assert.equal(body.error, "operation not implemented");
  assert.equal(body.method, "POST");
  assert.equal(body.path, UNREGISTERED_GATEWAY_PATH);
});

test("content-length above MAX_SAFE_INTEGER causes 413 via bigintToSafeNumber undefined path", async () => {
  // BigInt("9007199254740992") > Number.MAX_SAFE_INTEGER (9007199254740991),
  // so bigintToSafeNumber() returns undefined (line 1204). The declared size
  // also exceeds the 256 KiB generic limit, so 413 is returned.
  const router = createRouter();
  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: UNREGISTERED_GATEWAY_PATH,
    headers: { "content-length": "9007199254740992" },
  });
  assert.equal(response.statusCode, 413);
  const body = response.json();
  assert.equal(body.error, "request body too large");
  assert.equal(body.code, "request_body_too_large");
});

// ---------------------------------------------------------------------------
// Auth helpers  (lines 1229, 1236, 1241)
// ---------------------------------------------------------------------------

test("safeEqualToken length mismatch short-circuits comparison and causes 401", async () => {
  // safeEqualToken() returns false immediately when buffer lengths differ (line
  // 1229), without calling timingSafeEqual. The gateway-token check fails; with
  // no session token provided the request is rejected with 401.
  const router = createRouter({
    getGatewayAuthToken: () => "long-expected-token-value",
  });

  const response = await dispatchMockRequest({
    router,
    method: "POST",
    path: UNREGISTERED_GATEWAY_PATH,
    headers: {
      // "short" has a different byte-length from "long-expected-token-value",
      // so Buffer length comparison fires at line 1229 → return false.
      "x-desktop-gateway-token": "short",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "unauthorized");
});

test("isLoopbackAddress returns false for undefined address, blocking the exchange", async () => {
  // When socket.remoteAddress is undefined, isLoopbackAddress() hits the
  // falsy guard at line 1236 and returns false → exchange returns 403.
  const router = createRouter();
  const response = await driveRouter(router, {
    method: "POST",
    url: "/gateway-auth/exchange",
    headers: { origin: "https://app.closedloop.ai" },
    // remoteAddress intentionally omitted → undefined → isLoopbackAddress false
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "loopback only");
});

test("isLoopbackAddress accepts IPv6 loopback addresses ::1 and ::ffff:127.0.0.1", async () => {
  // Both IPv6 addresses pass the `address === "::1"` and
  // `address === "::ffff:127.0.0.1"` checks at line 1241+, so the exchange
  // endpoint does not return 403. In no-auth mode with no session store the
  // handler returns 500 — a different status than 403, proving loopback passed.
  for (const remoteAddress of ["::1", "::ffff:127.0.0.1"]) {
    const router = createRouter();
    const response = await driveRouter(router, {
      method: "POST",
      url: "/gateway-auth/exchange",
      headers: { origin: "https://app.closedloop.ai" },
      remoteAddress,
    });

    assert.equal(
      response.statusCode,
      500,
      `${remoteAddress} should pass the loopback check (not 403)`
    );
    assert.equal(
      response.json().error,
      "session store not available",
      "exchange proceeds past loopback guard but fails on missing session store"
    );
  }
});

// ---------------------------------------------------------------------------
// Error propagation  (line 598)
// ---------------------------------------------------------------------------

test("non-body-too-large stream error propagates out of readBody unswallowed", async () => {
  // The catch block at line 598 re-throws any error that is not an instance of
  // RequestBodyTooLargeError. This verifies that non-413 errors are never
  // silently swallowed by the body-size guard.
  const router = createRouter();

  function* streamThatThrows() {
    yield Buffer.from("x");
    throw new Error("synthetic mid-stream read failure");
  }

  const errorStream = Readable.from(streamThatThrows()) as Readable & {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress: string };
  };
  errorStream.method = "POST";
  errorStream.url = UNREGISTERED_GATEWAY_PATH;
  errorStream.headers = {};
  errorStream.socket = { remoteAddress: "127.0.0.1" };

  const fakeResponse = new TestResponse();
  await assert.rejects(
    router.handle(
      errorStream as unknown as http.IncomingMessage,
      fakeResponse as unknown as http.ServerResponse
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error, "thrown value must be an Error");
      assert.equal(err.message, "synthetic mid-stream read failure");
      return true;
    }
  );
});
