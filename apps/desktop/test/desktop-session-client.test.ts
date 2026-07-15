import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DesktopPopHeaders,
  DesktopPopSigningRequest,
} from "../src/main/desktop-pop.js";
import {
  refreshDesktopSession,
  revokeDesktopSession,
} from "../src/main/desktop-session-client.js";

const API_ORIGIN = "https://api.closedloop.test";

const SAMPLE_TOKENS = {
  accessToken: "access-token-value",
  accessTokenExpiresAt: "2026-06-30T16:15:00.000Z",
  refreshToken: "refresh-token-value",
  refreshTokenExpiresAt: "2026-07-30T16:00:00.000Z",
  userId: "user-1",
  organizationId: "org-1",
};

function popSignerStub(): {
  signer: (req: DesktopPopSigningRequest) => DesktopPopHeaders;
  calls: DesktopPopSigningRequest[];
} {
  const calls: DesktopPopSigningRequest[] = [];
  const signer = (req: DesktopPopSigningRequest): DesktopPopHeaders => {
    calls.push(req);
    return {
      "X-Desktop-Gateway-Id": "gateway-1",
      "X-Desktop-Timestamp": "1700000000",
      "X-Desktop-Signature": "sig-value",
    };
  };
  return { signer, calls };
}

type FetchCall = { url: string; init: RequestInit };

function fetchStub(response: Response | (() => never)): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (typeof response === "function") {
      response();
    }
    return Promise.resolve(response as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The transport (`postSignedDesktopSession`) — PoP signing, fetch, status→error
// mapping, and token parsing — is shared by every `/desktop/session/*` call and
// the `/desktop/authorize/token` redeem. `refreshDesktopSession` is the live
// representative used here to exercise that shared behavior.
test("a desktop session POST fails closed when the PoP signer returns null", async () => {
  const fetcher = fetchStub(jsonResponse(SAMPLE_TOKENS));
  const result = await refreshDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "old-refresh",
    popSigner: () => null,
    fetchImpl: fetcher.fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "pop_unavailable");
  assert.equal(fetcher.calls.length, 0, "no request without a PoP signature");
});

test("a desktop session POST maps shared contract error statuses", async () => {
  // `mapErrorResponse` is endpoint-agnostic, so these status→error mappings hold
  // for refresh, revoke, and the authorize-token redeem alike. (401 / 429 / 5xx
  // are covered by the dedicated refresh cases below.)
  const cases: Array<{
    status: number;
    body: unknown;
    error: string;
    retryable: boolean;
  }> = [
    {
      status: 403,
      body: { code: "DESKTOP_SESSION_POP_REQUIRED", retryable: false },
      error: "pop_rejected",
      retryable: false,
    },
    {
      status: 409,
      body: { code: "DESKTOP_SESSION_ALREADY_USED", retryable: false },
      error: "already_used",
      retryable: false,
    },
    {
      status: 400,
      body: { code: "DESKTOP_SESSION_ORG_REQUIRED", retryable: false },
      error: "org_required",
      retryable: false,
    },
  ];

  for (const testCase of cases) {
    const pop = popSignerStub();
    const fetcher = fetchStub(jsonResponse(testCase.body, testCase.status));
    const result = await refreshDesktopSession({
      apiOrigin: API_ORIGIN,
      refreshToken: "old-refresh",
      popSigner: pop.signer,
      fetchImpl: fetcher.fetchImpl,
    });
    assert.equal(result.ok, false, `status ${testCase.status}`);
    assert.equal(!result.ok && result.error, testCase.error);
    assert.equal(!result.ok && result.retryable, testCase.retryable);
  }
});

test("a desktop session POST reports a retryable network error when fetch throws", async () => {
  const pop = popSignerStub();
  const fetcher = fetchStub(() => {
    throw new Error("connection refused");
  });
  const result = await refreshDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "old-refresh",
    popSigner: pop.signer,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "network");
  assert.equal(!result.ok && result.retryable, true);
});

test("a desktop session POST rejects a success body missing token fields", async () => {
  const pop = popSignerStub();
  const fetcher = fetchStub(
    jsonResponse({ accessToken: "only-access", userId: "u" })
  );
  const result = await refreshDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "old-refresh",
    popSigner: pop.signer,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "invalid");
});

test("refreshDesktopSession signs the refresh path and rotates tokens", async () => {
  const pop = popSignerStub();
  const rotated = { ...SAMPLE_TOKENS, refreshToken: "rotated-refresh" };
  const fetcher = fetchStub(jsonResponse(rotated));

  const result = await refreshDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "old-refresh",
    popSigner: pop.signer,
    fetchImpl: fetcher.fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.refreshToken, "rotated-refresh");
  assert.equal(pop.calls[0]?.pathname, "/desktop/session/refresh");
});

test("refreshDesktopSession maps a 401 to a non-retryable invalid error", async () => {
  const pop = popSignerStub();
  const fetcher = fetchStub(
    jsonResponse({ code: "DESKTOP_SESSION_REFRESH_INVALID" }, 401)
  );
  const result = await refreshDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "old-refresh",
    popSigner: pop.signer,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "invalid");
  assert.equal(!result.ok && result.retryable, false);
});

test("refreshDesktopSession maps a 429 with no contract hint to a retryable error", async () => {
  // Edge infra (rate limiter / WAF) can return 429 even though the desktop
  // routes never do; it must stay retryable so a valid session is not wiped.
  const pop = popSignerStub();
  const fetcher = fetchStub(jsonResponse({ message: "rate limited" }, 429));
  const result = await refreshDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "old-refresh",
    popSigner: pop.signer,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "unavailable");
  assert.equal(!result.ok && result.retryable, true);
});

test("refreshDesktopSession maps an unexpected 5xx to a retryable unavailable error, not invalid", async () => {
  // A 5xx the desktop routes never emit (upstream/edge failure) must NOT be
  // conflated with a 401-style credential invalidation — otherwise the
  // authorize-code redeem would surface a transient server error to the user as
  // an expired code on a flow that is actually retryable.
  const pop = popSignerStub();
  const fetcher = fetchStub(jsonResponse({ message: "bad gateway" }, 502));
  const result = await refreshDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "old-refresh",
    popSigner: pop.signer,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "unavailable");
  assert.equal(!result.ok && result.retryable, true);
});

test("revokeDesktopSession signs the revoke path and resolves ok", async () => {
  const pop = popSignerStub();
  const fetcher = fetchStub(jsonResponse({ status: "revoked" }));

  const result = await revokeDesktopSession({
    apiOrigin: API_ORIGIN,
    refreshToken: "some-refresh",
    popSigner: pop.signer,
    fetchImpl: fetcher.fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(pop.calls[0]?.pathname, "/desktop/session/revoke");
});
