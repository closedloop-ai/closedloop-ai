/**
 * ISS-5299 — Gateway router plumbing tests.
 *
 * Covers routing fallthrough, the fallback proxy, and the header/auth helpers
 * in apps/desktop/src/server/router.ts and, since ISS-8234 moved it out,
 * `proxyToFallbackGateway` in apps/desktop/src/server/gateway-fallback-proxy.ts.
 * Lives as a sibling of
 * gateway-server.test.ts because that file is on the shrink-only
 * noExcessiveLinesPerFile grandfather list in biome.jsonc and must not grow.
 *
 * SECURITY CRITICAL: tests include the timing-safe token length-mismatch path
 * and the retired browser session exchange staying unreachable.
 */
import assert from "node:assert/strict";
import type http from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import { MEMBER_PACK_INSTALL_PATH } from "@repo/api/src/types/member-pack-install.js";
import { afterEach, expect, test } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { GatewayRouter } from "../src/server/router.js";
import { DesktopGatewayServer } from "../src/server/server.js";
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
  // gatewayLog is a module singleton with a 500-entry buffer and a
  // consecutive-duplicate latch; the ISS-7958 cases below read it.
  gatewayLog.clear();
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
// Constructor conditional registration  (line 484)
// ---------------------------------------------------------------------------

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
// Proxy fallback  (`proxyToFallbackGateway`, gateway-fallback-proxy.ts)
// ---------------------------------------------------------------------------

test("proxy skips falsy headers and always strips the host header", async () => {
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });

  let capturedHeaders: Headers | undefined;
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    // init.headers is the Headers instance built inside the fallback proxy.
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
      // Falsy (undefined) value → skipped by the proxy's
      // `if (!value) continue` header filter.
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
    "falsy header must be skipped by the proxy header filter"
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
      // join them rather than passing the raw array to fetch.
      "x-multi": ["first", "second", "third"],
    },
  });

  assert.ok(capturedHeaders, "fetch must have been called");
  assert.equal(
    capturedHeaders.get("x-multi"),
    "first, second, third",
    "array header must be joined with ', ' by the proxy"
  );
});

test("proxy falls back to GET when request method is undefined and sends no body", async () => {
  // Leaving method undefined exercises the ?? "GET" fallback at both
  // both in `handle` and in `proxyToFallbackGateway`. The GET path then takes
  // the `? undefined` branch of the body ternary.
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
    "GET must not send a body to the upstream"
  );
});

test("proxy forwards request body as Uint8Array for non-GET methods", async () => {
  // The `new Uint8Array(rawBody)` (false branch of the GET/HEAD ternary)
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

  // The proxy creates new Uint8Array(rawBody) for non-GET/HEAD.
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
  // skip prevents the upstream CORS header from being echoed back
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
  // `applyCorsHeaders` always sets access-control-allow-origin to the router's
  // own policy value before any routing, and the proxy then skips the upstream
  // copy of that header, so the upstream's value is never forwarded. The
  // observable proof: the response header carries the router's own value
  // ("https://app.closedloop.ai"), not "must-be-stripped".
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai",
    "header must contain the router CORS value, not the upstream value"
  );
  assert.equal(
    response.headers.get("x-upstream-custom"),
    "preserved",
    "non-CORS upstream headers must be forwarded"
  );
});

test("proxy ends response immediately when upstream has no body", async () => {
  // A plain object with body: null simulates a null-body upstream response,
  // triggering the `if (!upstreamResponse.body)` early return.
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
  // Passing an array exercises `firstHeaderValue`'s Array.isArray branch.
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
    "firstHeaderValue must return the first element of an array"
  );
});

test("parseBooleanHeader returns true for '1' and case-insensitive 'true', false otherwise", async () => {
  // x-desktop-force-approval is processed by parseBooleanHeader(), which is
  // called by `parseBooleanHeader`. True values "1", "true", "TRUE" and false values
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

  // "1"→true, "true"→true, "TRUE"→true (parseBooleanHeader true branch),
  // "garbage"→false, "0"→false.
  assert.deepEqual(capturedValues, [true, true, true, false, false]);
});

// ---------------------------------------------------------------------------
// Content-length handling  (lines 1198, 1204)
// ---------------------------------------------------------------------------

test("valid numeric content-length header enters BigInt parse path without rejecting", async () => {
  // content-length "50" is below the 256 KiB generic limit. BigInt("50") is
  // computed but does not exceed the cap, so no 413 is thrown.
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

test("the retired /gateway-auth/exchange route mints no session and answers 404 (ISS-12749)", async () => {
  // No gateway auth token is configured, which is the state the deleted
  // exchange used to answer with a 24-hour session and no challenge at all.
  const router = createRouter();
  const response = await driveRouter(router, {
    method: "POST",
    url: "/gateway-auth/exchange",
    headers: { origin: "https://app.closedloop.ai" },
    remoteAddress: "127.0.0.1",
    chunks: [JSON.stringify({ challengeToken: "challenge-abc" })],
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().sessionToken, undefined);
});

// ---------------------------------------------------------------------------
// Error propagation  (line 598)
// ---------------------------------------------------------------------------

test("a non-body-too-large stream error is answered, never rethrown", async () => {
  // The body-size guard still refuses to swallow a non-413 error — it re-throws
  // out of readBody exactly as before. What ISS-8566 changed is where that
  // throw lands: `handle`'s top-level catch now answers it, instead of letting
  // it escape as the unhandled rejection `handleUnhandledRejection` turns into
  // exit(1) for the whole app.
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
  await assert.doesNotReject(
    router.handle(
      errorStream as unknown as http.IncomingMessage,
      fakeResponse as unknown as http.ServerResponse
    ),
    "handle() must not reject: server.ts discards it with a bare void"
  );
  // The socket is still up — only the read failed — so this is our fault to
  // report, and the caller gets a generic 500 rather than a dead connection.
  assert.equal(fakeResponse.statusCode, 500);
  assert.deepEqual(fakeResponse.json(), { error: "internal error" });
  assert.equal(
    fakeResponse.text().includes("synthetic mid-stream read failure"),
    false,
    "the 500 body must not leak the internal error"
  );
});

// ---------------------------------------------------------------------------
// Malformed request target  (ISS-7958)
// ---------------------------------------------------------------------------

/**
 * Request targets llhttp accepts in absolute form but the WHATWG URL parser
 * rejects. Before ISS-7958 each threw out of `handle`; because `server.ts`
 * calls it as `void this.router.handle(...)` with no `.catch`, that throw
 * became an unhandledRejection and quit the app (error-handlers.ts → exit(1)).
 */
const MALFORMED_REQUEST_TARGETS = ["http://[", "http://%"] as const;

/** Mirrors MAX_LOGGED_REQUEST_TARGET_CHARS in router.ts (module-private there). */
const MAX_LOGGED_REQUEST_TARGET_CHARS = 120;

/** Counts calls to the private auth check without altering its verdict. */
function spyOnAuthCheck(router: GatewayRouter): () => number {
  const internals = router as unknown as {
    isAuthorizedGatewayRequest: (request: http.IncomingMessage) => unknown;
  };
  const original = internals.isAuthorizedGatewayRequest.bind(router);
  let calls = 0;
  internals.isAuthorizedGatewayRequest = (request) => {
    calls += 1;
    return original(request);
  };
  return () => calls;
}

test("malformed request target answers 400 before auth instead of crashing", async () => {
  for (const target of MALFORMED_REQUEST_TARGETS) {
    const router = createRouter();
    const authCalls = spyOnAuthCheck(router);
    gatewayLog.clear();

    // Awaiting IS the "handle resolves" assertion: without the guard this
    // promise rejects and the case fails right here, which is the production
    // unhandledRejection that reaches app.exit(1).
    const response = await driveRouter(router, { method: "GET", url: target });

    assert.equal(response.statusCode, 400, `status for ${target}`);
    assert.deepEqual(response.json(), { error: "malformed request target" });
    // Pins that the guard sits BEFORE auth. A fix that instead wrapped the
    // whole handler body would run auth first and land this at 1.
    assert.equal(authCalls(), 0, `auth must not run for ${target}`);
    // The pre-fix input was loud in the worst way (crash telemetry + exit(1)).
    // Rejecting it silently would trade a crash for invisibility, so the
    // rejection owes the operator one warn-level entry naming the target.
    const warnings = gatewayLog
      .getEntries()
      .filter(
        (entry) => entry.level === "warn" && entry.tag === "gateway-router"
      );
    assert.equal(warnings.length, 1, `one warn entry for ${target}`);
    assert.ok(
      warnings[0].message.startsWith("malformed_request_target "),
      `warn entry must carry the code, got: ${warnings[0].message}`
    );
    assert.ok(
      warnings[0].message.includes(`target=${target}`),
      `warn entry must name the rejected target, got: ${warnings[0].message}`
    );
  }
});

test("logged malformed target is capped so an unbounded one cannot flood the log", async () => {
  const router = createRouter();
  gatewayLog.clear();

  // Malformed (unterminated IPv6 literal) AND far longer than the cap.
  const target = `http://[${"a".repeat(4000)}`;
  const response = await driveRouter(router, { method: "GET", url: target });

  assert.equal(response.statusCode, 400);
  const logged = gatewayLog
    .getEntries()
    .filter((entry) => entry.tag === "gateway-router")
    .map((entry) => entry.message.split("target=")[1] ?? "");
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.length, MAX_LOGGED_REQUEST_TARGET_CHARS);
  assert.ok(
    target.startsWith(logged[0] ?? ""),
    "cap must truncate, not mangle"
  );
});

test("well-formed request target still reaches auth and routes unchanged", async () => {
  // The allow case for the same branch: proves the guard rejects only invalid
  // targets. A guard that 400s everything passes the case above and fails here.
  const router = createRouter();
  const authCalls = spyOnAuthCheck(router);

  const response = await driveRouter(router, {
    method: "GET",
    url: "/totally-unknown-path",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "route not found" });
  assert.equal(authCalls(), 1, "valid targets must still reach the auth check");
});

// ---------------------------------------------------------------------------
// Fallback proxy failure containment  (ISS-8234)
//
// `server.ts` dispatches with a bare `void this.router.handle(...)`, so any
// rejection escaping the fallback proxy reached `handleUnhandledRejection`,
// which calls `app.exit(1)`: an unreachable dev fallback quit the whole Electron
// app, and case 2 below did it with no error shown at all. Each case asserts the
// returned promise RESOLVES as well as the status — the status alone is written
// before the throw would happen and so cannot prove the app survived.
// ---------------------------------------------------------------------------

/** Drives `handle` without awaiting, so the test owns the returned promise. */
function handleUnrouted(
  router: GatewayRouter,
  headers: http.IncomingHttpHeaders = {}
): {
  promise: Promise<void>;
  response: TestResponse;
} {
  const stream = Readable.from([]) as Readable & {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  stream.method = "GET";
  stream.url = UNREGISTERED_GATEWAY_PATH;
  stream.headers = headers;
  stream.socket = { remoteAddress: "127.0.0.1" };
  const response = new TestResponse();
  return {
    promise: router.handle(
      stream as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse
    ),
    response,
  };
}

test("a scheme-less fallback origin answers 502 instead of crashing the app", async () => {
  // `new URL("/api/gateway/…", "localhost:3000")` throws TypeError: Invalid URL.
  // Reachable because `fallbackGatewayOrigin` is a constructor option; the
  // startup validation in server.ts guards only the env-var route to it.
  const router = createRouter({ fallbackGatewayOrigin: "localhost:3000" });
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof globalThis.fetch;

  const { promise, response } = handleUnrouted(router);

  await expect(promise).resolves.toBeUndefined();
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: "fallback gateway unreachable" });
  assert.equal(
    fetchCalled,
    false,
    "a malformed origin must fail before any request leaves the machine"
  );
});

test("an unreachable fallback answers 502 instead of crashing the app", async () => {
  // The easier case: a correctly formatted origin whose server was never
  // started. The bare `await fetch` rejected with ECONNREFUSED.
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });
  globalThis.fetch = (() =>
    Promise.reject(
      Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" })
    )) as typeof globalThis.fetch;

  const { promise, response } = handleUnrouted(router);

  await expect(promise).resolves.toBeUndefined();
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: "fallback gateway unreachable" });
});

test("a fallback body that fails mid-read answers 502 with the upstream headers cleared", async () => {
  // The upstream replied, so its headers are already staged on the response
  // when the body read rejects. They must be cleared before the 502 body — a
  // staged content-length describing the upstream body would make `end()` throw
  // ERR_HTTP_CONTENT_LENGTH_MISMATCH, i.e. the crash this guard exists to stop.
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("upstream aborted mid-body"));
          },
        }),
        { status: 200, headers: { "x-upstream-only": "must-be-cleared" } }
      )
    )) as typeof globalThis.fetch;

  const { promise, response } = handleUnrouted(router);

  await expect(promise).resolves.toBeUndefined();
  assert.equal(response.statusCode, 502);
  assert.equal(
    response.headers.has("x-upstream-only"),
    false,
    "upstream headers must not survive onto the error response"
  );
  assert.deepEqual(response.json(), { error: "fallback gateway unreachable" });
});

test("the 502 keeps the gateway's own CORS headers so the caller can read it", async () => {
  // `GatewayRouter.handle` stages the CORS headers via `applyCorsHeaders` before
  // it delegates to the proxy, and the error path clears staged headers to make
  // the 502 writable. Clearing the gateway's own headers along with the
  // upstream's leaves the renderer — which reaches this gateway cross-origin —
  // holding a generic browser CORS failure instead of the JSON error, i.e. the
  // honest status replaced by no status at all.
  const router = createRouter({ fallbackGatewayOrigin: FALLBACK_ORIGIN });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("upstream aborted mid-body"));
          },
        }),
        { status: 200, headers: { "x-upstream-only": "must-be-cleared" } }
      )
    )) as typeof globalThis.fetch;

  const { promise, response } = handleUnrouted(router, {
    origin: "https://app.closedloop.ai",
  });

  await expect(promise).resolves.toBeUndefined();
  assert.equal(response.statusCode, 502);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://app.closedloop.ai",
    "the gateway's CORS grant must survive the clear that drops upstream headers"
  );
  assert.equal(
    response.headers.has("x-upstream-only"),
    false,
    "upstream headers must still not survive onto the error response"
  );
  assert.deepEqual(response.json(), { error: "fallback gateway unreachable" });
});

// ---------------------------------------------------------------------------
// SYMPHONY_GATEWAY_FALLBACK_ORIGIN startup validation  (ISS-8234)
//
// The env-var route to `fallbackGatewayOrigin`, which the constructor-option
// cases above deliberately bypass. A misconfigured value must be a startup
// error naming the variable, not a per-request 502 that never says why.
// ---------------------------------------------------------------------------

const FALLBACK_ORIGIN_ENV_NAME_PATTERN = /SYMPHONY_GATEWAY_FALLBACK_ORIGIN/;
const SCHEME_LESS_ORIGIN_PATTERN = /localhost:3000/;
const PATH_BEARING_ORIGIN_PATTERN = /gateway-prefix/;

function withFallbackOriginEnv<T>(value: string, run: () => T): T {
  const had = Object.hasOwn(process.env, "SYMPHONY_GATEWAY_FALLBACK_ORIGIN");
  const previous = process.env.SYMPHONY_GATEWAY_FALLBACK_ORIGIN;
  process.env.SYMPHONY_GATEWAY_FALLBACK_ORIGIN = value;
  try {
    return run();
  } finally {
    // Assigning `undefined` would leave the STRING "undefined" behind, which
    // is truthy and would configure a bogus origin for every later test here.
    if (had) {
      process.env.SYMPHONY_GATEWAY_FALLBACK_ORIGIN = previous;
    } else {
      Reflect.deleteProperty(process.env, "SYMPHONY_GATEWAY_FALLBACK_ORIGIN");
    }
  }
}

function createDefaultGatewayServer(): DesktopGatewayServer {
  return DesktopGatewayServer.createDefault(
    "https://app.closedloop.ai",
    () => undefined,
    () => [os.tmpdir()],
    "plumbing-test-machine",
    "0.1.0-test",
    EMPTY_CAPABILITIES
  );
}

test("a scheme-less SYMPHONY_GATEWAY_FALLBACK_ORIGIN fails at startup, naming the variable", () => {
  // The exact typo the ticket names. `URL.canParse("localhost:3000")` is TRUE —
  // `localhost:` parses as a custom scheme — so the one-argument check this
  // guard originally used waved the value through and every fallback request
  // degraded to the generic 502. The two-argument form runs the same operation
  // the proxy does and rejects it here, where the message can name the var.
  withFallbackOriginEnv("localhost:3000", () => {
    assert.throws(createDefaultGatewayServer, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, FALLBACK_ORIGIN_ENV_NAME_PATTERN);
      assert.match(error.message, SCHEME_LESS_ORIGIN_PATTERN);
      return true;
    });
  });
});

test("a path-bearing SYMPHONY_GATEWAY_FALLBACK_ORIGIN fails at startup", () => {
  // ISS-8234 review (whitlockk): a prefix does not survive the proxy. `requestPath`
  // is always absolute, so `new URL("/api/gateway/x", "http://host/prefix")`
  // resolves at the HOST ROOT and drops the prefix — the base parses, the join
  // succeeds, and every proxied request quietly goes somewhere else. Accepting
  // it would be a configuration that reads as applied and never is.
  withFallbackOriginEnv("http://localhost:3000/gateway-prefix", () => {
    assert.throws(createDefaultGatewayServer, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, FALLBACK_ORIGIN_ENV_NAME_PATTERN);
      assert.match(error.message, PATH_BEARING_ORIGIN_PATTERN);
      return true;
    });
  });
});

test("a bare origin is accepted at startup", async () => {
  // The false-positive guard on both rejection cases: the checks must not
  // tighten into something that refuses the value the README documents.
  const server = withFallbackOriginEnv(
    "http://localhost:3000",
    createDefaultGatewayServer
  );
  let fetchedUrl: string | undefined;
  globalThis.fetch = ((url: RequestInfo | URL) => {
    fetchedUrl = String(url);
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof globalThis.fetch;
  const router = (server as unknown as { router: GatewayRouter }).router;

  await handleUnrouted(router).promise;

  assert.ok(fetchedUrl?.startsWith("http://localhost:3000/api/gateway/"));
  await server.stop();
});
