/**
 * ISS-5299 — Gateway authorization and /gateway-auth/exchange rejection paths.
 *
 * SECURITY CRITICAL: covers the authorization boundary of the Engineer feature
 * gateway. Tests the `isAuthorizedGatewayRequest` rejection arms (session-token
 * missing origin, session-token with no session store, `safeEqualToken` length
 * mismatch) and every failure mode on the `/gateway-auth/exchange` flow
 * (non-loopback address, no-auth without session store, missing API origin,
 * oversized body, stream error rethrow, malformed challengeToken, verifyChallenge
 * failure, and verifyChallenge success with no session store).
 *
 * ISS-6128 appends the fail-closed arms that survived that pass: the
 * `timingSafeEqual` half of the gateway-token comparison, and both guards on
 * the opaque `Origin: null` a sandboxed browser context sends.
 *
 * Lives beside `gateway-server.test.ts` rather than inside it because that file
 * is on the shrink-only grandfather list in `biome.jsonc`. Adding even one line
 * to it would violate the never-grow rule for grandfathered files (AGENTS.md).
 */
import assert from "node:assert/strict";
import type http from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { LocalSessionStore } from "../src/main/auth/local-session-store.js";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { GatewayRouter } from "../src/server/router.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  dispatchMockRequest,
  TestResponse,
} from "./gateway-server-test-doubles.js";

// ---------------------------------------------------------------------------
// Module-level state and cleanup
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a GatewayRouter with production-valid defaults.
 *
 * `schedulers` is always included — omitting it constructs a router production
 * can never build (the loop routes require a non-null context).
 */
function makeRouter(
  overrides: Partial<ConstructorParameters<typeof GatewayRouter>[0]> = {}
): GatewayRouter {
  return new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "router-auth-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    schedulers: new LoopSchedulerContext(),
    ...overrides,
  });
}

/**
 * Dispatch a POST /gateway-auth/exchange request with a loopback address and a
 * default origin header so callers only need to vary what they're testing.
 */
function dispatchExchange(input: {
  router: GatewayRouter;
  headers?: http.IncomingHttpHeaders;
  chunks?: Array<string | Buffer>;
  remoteAddress?: string;
}): Promise<TestResponse> {
  return dispatchMockRequest({
    router: input.router,
    method: "POST",
    path: "/gateway-auth/exchange",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      ...input.headers,
    },
    chunks: input.chunks,
    remoteAddress: input.remoteAddress,
  });
}

// ---------------------------------------------------------------------------
// handleExchange rejection paths
// ---------------------------------------------------------------------------

/**
 * Line 806: `isLoopbackAddress` guard — remote address is not loopback.
 *
 * The exchange endpoint only accepts connections from the local machine. A
 * request arriving from a routable IP must be rejected with 403 so that a
 * compromised network peer cannot mint browser session tokens.
 */
test("exchange route rejects non-loopback remote address with 403 loopback only", async () => {
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    sessionStore: new LocalSessionStore(),
  });

  const response = await dispatchExchange({
    router,
    remoteAddress: "10.0.0.5",
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "loopback only");
});

/**
 * Line 838: no-auth mode (no gateway auth token configured) but no session
 * store injected → 500.
 *
 * Without a gateway token the router skips challenge verification and tries to
 * create a session immediately. When the session store is absent the router
 * must surface the configuration error rather than panic.
 */
test("exchange route in no-auth mode without session store returns 500 session store not available", async () => {
  // No getGatewayAuthToken → no-auth mode; no sessionStore → error
  const router = makeRouter();

  const response = await dispatchExchange({ router });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error, "session store not available");
});

/**
 * Line 872: `getApiOrigin` is not configured → 503.
 *
 * Challenge verification requires calling the cloud API. When the origin is
 * absent the router must reject with 503 rather than attempting a fetch to an
 * undefined URL.
 */
test("exchange route without api origin configured returns 503", async () => {
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    // getApiOrigin deliberately absent
  });

  const response = await dispatchExchange({ router });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "API origin not configured");
});

/**
 * Lines 885, 892, 1021: exchange route body exceeds the 4 KiB cap and no
 * Content-Length header is present.
 *
 * When the streaming byte count crosses the limit the router must return 413
 * and include the machine-readable error code. The absence of Content-Length
 * exercises the `declaredSizeBytes === null → undefined` branch inside
 * `readBody` (line 1021 of router.ts).
 */
test("exchange route returns 413 when body exceeds limit without content-length", async () => {
  // GATEWAY_AUTH_EXCHANGE_LIMIT_BYTES = 4 * 1024 = 4096
  const overLimitBody = "x".repeat(4097);

  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    getApiOrigin: () => "http://api-test.local",
  });

  // No content-length header so declaredSizeBytes === null inside readBody
  const response = await dispatchExchange({
    router,
    chunks: [overLimitBody],
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error, "request body too large");
  assert.equal(response.json().code, "request_body_too_large");
});

/**
 * Line 903: exchange route re-throws non-body-limit stream errors.
 *
 * `readBody` iterates the request stream with `for await`. If the stream emits
 * an error that is not a `RequestBodyTooLargeError` the router must not swallow
 * it — the error propagates out of `handleExchange` and up through `handle`.
 */
test("exchange route rethrows non-body-limit stream errors", {
  timeout: 10_000,
}, async () => {
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    getApiOrigin: () => "http://api-test.local",
  });

  const request = new Readable({
    read() {
      this.destroy(new Error("injected exchange stream error"));
    },
  }) as Readable & {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  request.method = "POST";
  request.url = "/gateway-auth/exchange";
  request.headers = {
    origin: "http://localhost:3000",
    "content-type": "application/json",
  };
  request.socket = { remoteAddress: "127.0.0.1" };

  const response = new TestResponse();

  await assert.rejects(
    router.handle(
      request as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse
    ),
    { message: "injected exchange stream error" }
  );
});

/**
 * Line 916 (catch block entry via JSON.parse failure): non-JSON body → 400.
 */
test("exchange route returns 400 for non-JSON body", async () => {
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    getApiOrigin: () => "http://api-test.local",
  });

  const response = await dispatchExchange({
    router,
    chunks: ["not-valid-json{{"],
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json().error,
    "invalid request body: challengeToken required"
  );
});

/**
 * Line 912, left branch of `||` (typeof !== "string"): challengeToken is a
 * number → 400.
 */
test("exchange route returns 400 when challengeToken is not a string", async () => {
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    getApiOrigin: () => "http://api-test.local",
  });

  const response = await dispatchExchange({
    router,
    chunks: [JSON.stringify({ challengeToken: 12_345 })],
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json().error,
    "invalid request body: challengeToken required"
  );
});

/**
 * Line 912, right branch of `||` (`!parsed.challengeToken`): challengeToken is
 * an empty string → 400.
 */
test("exchange route returns 400 when challengeToken is an empty string", async () => {
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    getApiOrigin: () => "http://api-test.local",
  });

  const response = await dispatchExchange({
    router,
    chunks: [JSON.stringify({ challengeToken: "" })],
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json().error,
    "invalid request body: challengeToken required"
  );
});

/**
 * Lines 939, 945: verifyChallenge fails → error forwarded to caller.
 *
 * Line 939: `getApiKeyProvenance?.() ?? "USER_CREATED"` — router without
 * `getApiKeyProvenance` exercises the `?? "USER_CREATED"` fallback.
 * Line 945: `result.statusCode ?? 401` — verifyChallenge returns a
 * statusCode, exercising the defined-statusCode path.
 *
 * globalThis.fetch is swapped so verifyChallenge makes no real network call.
 */
test("exchange route forwards verifyChallenge failure with its status code and error", async () => {
  // No getApiKeyProvenance → exercises the ?? "USER_CREATED" fallback on line 939
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    getApiOrigin: () => "http://api-test.local",
    sessionStore: new LocalSessionStore(),
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "challenge token rejected" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const response = await dispatchExchange({
    router,
    chunks: [
      JSON.stringify({ challengeToken: "valid-looking-challenge-abc123" }),
    ],
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "challenge token rejected");
});

/**
 * Line 957: verifyChallenge succeeds but session store is absent → 500.
 *
 * After a successful challenge verification the router tries to create a browser
 * session. If the session store was not injected the router must surface the
 * configuration error.
 */
test("exchange route returns 500 when verifyChallenge succeeds but session store is absent", async () => {
  // No sessionStore — production misconfiguration scenario
  const router = makeRouter({
    getGatewayAuthToken: () => "test-auth-token",
    getApiKey: () => "sk_live_testkey",
    getApiOrigin: () => "http://api-test.local",
  });

  // unwrapApiResultData({ok:true, sessionTtlSeconds:3600}) → {ok:true, sessionTtlSeconds:3600}
  // because there is no `success: true` wrapper, so the record is returned as-is
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const response = await dispatchExchange({
    router,
    chunks: [
      JSON.stringify({ challengeToken: "valid-looking-challenge-xyz987" }),
    ],
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error, "session store not available");
});

// ---------------------------------------------------------------------------
// isAuthorizedGatewayRequest rejection paths
// ---------------------------------------------------------------------------

/**
 * Lines 559, 760: session token is present but the Origin header is absent.
 *
 * Line 760 is the specific rejection branch inside `isAuthorizedGatewayRequest`.
 * Line 559 is the activityDetail assignment in the 401 response block —
 * it is only reached when a gateway route rejects auth, which existing tests
 * never exercise (they use no-auth mode).
 *
 * SECURITY CRITICAL: a session token without an Origin header must always be
 * rejected so that opaque cross-origin requests cannot steal sessions.
 */
test("gateway route returns 401 when session token is present but origin header is absent", async () => {
  const store = new LocalSessionStore();
  const router = makeRouter({
    getGatewayAuthToken: () => "test-gateway-token",
    sessionStore: store,
  });
  const { sessionToken } = store.create("http://localhost:3000");

  const response = await dispatchMockRequest({
    router,
    method: "GET",
    path: "/api/gateway/iss5299-noop",
    headers: {
      "x-desktop-session-token": sessionToken,
      // no origin header
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(
    response.json().reason,
    "session token present but Origin header missing"
  );
});

/**
 * Line 766: session token is present, origin header is set, but the session
 * store is not configured → 401 "session store not configured".
 *
 * SECURITY CRITICAL: the router must not fall back to allowing the request
 * when the session store is missing.
 */
test("gateway route returns 401 when session token and origin present but session store absent", async () => {
  const router = makeRouter({
    getGatewayAuthToken: () => "test-gateway-token",
    // sessionStore deliberately absent
  });

  const response = await dispatchMockRequest({
    router,
    method: "GET",
    path: "/api/gateway/iss5299-noop",
    headers: {
      "x-desktop-session-token": "some-unvalidated-token-value",
      origin: "http://localhost:3000",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().reason, "session store not configured");
});

/**
 * `safeEqualToken` length-mismatch early return: a gateway token whose byte
 * length differs from the expected token must not authorize the request.
 *
 * SECURITY CRITICAL: `safeEqualToken` uses `timingSafeEqual` which requires
 * equal-length buffers. The length check short-circuits before the timing-safe
 * comparison, ensuring mismatched-length tokens are always rejected.
 */
test("gateway token with different byte length than expected does not authorize", async () => {
  // Expected token: 5 bytes. Provided token: 31 bytes. Length mismatch → reject.
  const router = makeRouter({
    getGatewayAuthToken: () => "short",
  });

  const response = await dispatchMockRequest({
    router,
    method: "GET",
    path: "/api/gateway/iss5299-noop",
    headers: {
      "x-desktop-gateway-token": "much-longer-gateway-token-value",
    },
  });

  assert.equal(response.statusCode, 401);
});

// ---------------------------------------------------------------------------
// evaluateApproval — remoteAddress propagation (line 610)
// ---------------------------------------------------------------------------

/**
 * Line 610: `request.socket.remoteAddress ?? null` — the `?? null` branch
 * executes when `socket.remoteAddress` is absent (undefined).
 *
 * `dispatchMockRequest` always defaults to "127.0.0.1", so this test builds the
 * request manually to leave `socket.remoteAddress` undefined.
 */
test("evaluateApproval receives null remoteAddress when socket.remoteAddress is absent", {
  timeout: 10_000,
}, async () => {
  let capturedRemoteAddress: unknown = "not-called";

  const router = makeRouter({
    evaluateApproval: (req) => {
      capturedRemoteAddress = req.remoteAddress;
      // Block the request to avoid reaching the actual dispatcher
      return { allow: false, statusCode: 403, payload: { error: "blocked" } };
    },
  });

  // Build a request manually so socket.remoteAddress is undefined
  const request = Readable.from([]) as Readable & {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  request.method = "GET";
  request.url = "/api/gateway/iss5299-noop";
  request.headers = {};
  request.socket = { remoteAddress: undefined };

  const response = new TestResponse();
  await router.handle(
    request as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse
  );

  // The approval callback ran and received null for the absent remoteAddress
  assert.equal(capturedRemoteAddress, null);
});

// ---------------------------------------------------------------------------
// Gateway route stream error rethrow (line 598)
// ---------------------------------------------------------------------------

/**
 * Line 598: gateway route re-throws stream errors that are not
 * `RequestBodyTooLargeError`.
 *
 * When the request body stream errors unexpectedly the router must not swallow
 * it — the error propagates out of `handle` so the server layer can log it and
 * close the connection.
 */
test("gateway route rethrows non-body-limit stream errors from readBody", {
  timeout: 10_000,
}, async () => {
  // No auth token → no-auth mode, gateway route proceeds to readBody
  const router = makeRouter();

  const request = new Readable({
    read() {
      this.destroy(new Error("injected gateway stream error"));
    },
  }) as Readable & {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  request.method = "GET";
  request.url = "/api/gateway/iss5299-noop";
  request.headers = {};
  request.socket = { remoteAddress: "127.0.0.1" };

  const response = new TestResponse();

  await assert.rejects(
    router.handle(
      request as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse
    ),
    { message: "injected gateway stream error" }
  );
});

/**
 * `safeEqualToken`'s timing-safe comparison arm: a gateway token of the correct
 * LENGTH but the wrong VALUE must not authorize.
 *
 * Every existing gateway-token rejection test — the length-mismatch case above,
 * its twin in `gateway-router-plumbing.test.ts`, and the no-token case in
 * `gateway-server.test.ts` — stops at `safeEqualToken`'s
 * `leftBuffer.length !== rightBuffer.length` early return. `timingSafeEqual`,
 * the comparison that actually checks the secret, is reached by none of them:
 * replacing its result with `true` leaves the whole existing suite green.
 *
 * The matching-token dispatch is a positive control, not decoration. Without
 * it, deleting the ENTIRE Path-1 block still leaves this test green — the
 * trailing no-credential branch answers with the same 401 — so the test would
 * not fail on removal of the very check its name describes.
 *
 * Status only, deliberately: this 401 carries the reason "no credential
 * provided" even though a credential WAS presented, and that same string
 * becomes the `activityDetail` of the emitted `security` event. Asserting it
 * would freeze an audit trail that cannot tell a token brute-force apart from
 * an anonymous probe.
 */
test("gateway token authorizes only on an exact value match", async () => {
  const router = makeRouter({ getGatewayAuthToken: () => "aaaaaaaaaaaaaaaa" });
  const dispatch = (token: string) =>
    dispatchMockRequest({
      router,
      method: "GET",
      path: "/api/gateway/iss6128-noop",
      headers: { "x-desktop-gateway-token": token },
    });

  // Same byte length, last character differs: the length short-circuit cannot
  // answer, so timingSafeEqual is what must reject it.
  assert.equal((await dispatch("aaaaaaaaaaaaaaab")).statusCode, 401);
  // The correct token reaches the dispatcher and gets the unimplemented-route
  // answer an AUTHORIZED request gets — which a deleted Path-1 block cannot.
  assert.equal((await dispatch("aaaaaaaaaaaaaaaa")).statusCode, 501);
});

/**
 * The opaque-origin guard on the USE side of a browser session.
 *
 * `LocalSessionStore.create` binds a session to whatever origin string it is
 * handed and `validate` accepts an exact match, so a session bound to the
 * opaque origin `"null"` would validate against a request carrying
 * `Origin: null`. The `requestOrigin === "null"` arm of
 * `isAuthorizedGatewayRequest` is the only thing that stops it — and no test
 * executed that arm: the sibling test above covers the ABSENT-origin half of
 * the same condition, which the store would have rejected anyway.
 *
 * SECURITY CRITICAL: a sandboxed iframe, a `file://` page, and a cross-origin
 * redirect all send `Origin: null`. Drop `|| requestOrigin === "null"` and this
 * request is authorized.
 */
test("gateway route rejects an opaque null Origin even against a session bound to it", async () => {
  const store = new LocalSessionStore();
  const router = makeRouter({
    getGatewayAuthToken: () => "test-gateway-token",
    sessionStore: store,
  });
  const { sessionToken } = store.create("null");

  const response = await dispatchMockRequest({
    router,
    method: "GET",
    path: "/api/gateway/iss6128-noop",
    headers: {
      "x-desktop-session-token": sessionToken,
      origin: "null",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(
    response.json().reason,
    "session token present but Origin header missing"
  );
});

/**
 * The opaque-origin guard on the MINT side — the arm that keeps the session
 * above from existing in the first place.
 *
 * With no gateway auth token configured the exchange route skips challenge
 * verification and issues a 24-hour session immediately, bound to the request's
 * Origin. Existing coverage exercises only the ABSENT-origin half of that
 * guard, so the literal `"null"` an opaque browser context actually sends was
 * never executed.
 *
 * Asserts the guarantee — nothing was minted — not only the status code.
 */
test("exchange route refuses to mint a session for an opaque null Origin", async () => {
  const store = new LocalSessionStore();
  // No getGatewayAuthToken → no-auth mode, which mints without challenge
  // verification; the Origin guard is the only thing in the way.
  const router = makeRouter({ sessionStore: store });

  const response = await dispatchExchange({
    router,
    headers: { origin: "null" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "Origin header required");
  assert.equal(store.activeCount, 0);
});
