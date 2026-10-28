/**
 * ISS-5299 — Gateway authorization rejection paths.
 *
 * SECURITY CRITICAL: covers the authorization boundary of the Engineer feature
 * gateway. Tests the `isAuthorizedGatewayRequest` rejection arms (session-token
 * missing origin, session-token with no session store, `safeEqualToken` length
 * mismatch).
 *
 * ISS-6128 appends the fail-closed arms that survived that pass: the
 * `timingSafeEqual` half of the gateway-token comparison, and the guard on the
 * opaque `Origin: null` a sandboxed browser context sends.
 *
 * Lives beside `gateway-server.test.ts` rather than inside it because that file
 * is on the shrink-only grandfather list in `biome.jsonc`. Adding even one line
 * to it would violate the never-grow rule for grandfathered files (AGENTS.md).
 */
import assert from "node:assert/strict";
import type http from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import { test } from "vitest";
import { LocalSessionStore } from "../src/main/auth/local-session-store.js";
import { AuthReason } from "../src/server/gateway-auth-reasons.js";
import { GatewayRouter } from "../src/server/router.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import {
  dispatchMockRequest,
  TestResponse,
} from "./gateway-server-test-doubles.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build a GatewayRouter with production-valid defaults. */
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
    ...overrides,
  });
}

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
  assert.equal(response.json().reason, AuthReason.SessionTokenWithoutOrigin);
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
  assert.equal(response.json().reason, AuthReason.SessionStoreMissing);
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
test("gateway route answers non-body-limit stream errors from readBody instead of rethrowing", {
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

  // ISS-8566: readBody still re-throws anything that is not a
  // RequestBodyTooLargeError, but handle()'s top-level catch now answers it.
  // Letting it escape made it an unhandled rejection, and server.ts discards
  // the dispatch with a bare `void`, so handleUnhandledRejection called
  // exit(1) and took the whole app down.
  await assert.doesNotReject(
    router.handle(
      request as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse
    ),
    "handle() must not reject"
  );
  // The socket is still up, so the caller gets a generic 500 rather than a
  // torn-down connection, and the internal message never reaches the body.
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: "internal error" });
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
  assert.equal(response.json().reason, AuthReason.SessionTokenWithoutOrigin);
});
