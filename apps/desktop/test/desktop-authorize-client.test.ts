import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  decodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import {
  buildDesktopAuthorizeUrl,
  redeemDesktopAuthorizationCode,
} from "../src/main/desktop-authorize-client.js";
import type {
  DesktopPopHeaders,
  DesktopPopSigningRequest,
} from "../src/main/desktop-pop.js";

const API_ORIGIN = "https://api.closedloop.test";
const REDIRECT_URI = "http://127.0.0.1:49152/cb";
const SAMPLE_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----";
// PEM characters (+, /, =, space, newline) a sign-in redirect hop can corrupt.
const FRAGILE_CHARS_RE = /[+/= \n]/;

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

function fetchStub(response: Response): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function redeem(
  fetchImpl: typeof fetch,
  signer: ReturnType<typeof popSignerStub>["signer"]
) {
  return redeemDesktopAuthorizationCode({
    apiOrigin: API_ORIGIN,
    code: "auth-code",
    codeVerifier: "verifier-value",
    gatewayId: "gateway-1",
    redirectUri: REDIRECT_URI,
    popSigner: signer,
    fetchImpl,
  });
}

test("buildDesktopAuthorizeUrl targets the authorize path with snake_case params", () => {
  const url = new URL(
    buildDesktopAuthorizeUrl({
      webAppOrigin: "https://app.closedloop.test",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      state: "state-xyz",
      redirectUri: REDIRECT_URI,
      gatewayId: "gateway-1",
      gatewayPublicKeyPem: SAMPLE_PUBLIC_KEY_PEM,
      deviceName: "Kris's MacBook",
      platform: "darwin",
    })
  );

  const params = url.searchParams;
  const key = DESKTOP_AUTHORIZE_QUERY_PARAMS;
  assert.equal(url.origin, "https://app.closedloop.test");
  assert.equal(url.pathname, "/settings/integrations/desktop/authorize");
  assert.equal(params.get(key.codeChallenge), "challenge");
  assert.equal(params.get(key.codeChallengeMethod), "S256");
  assert.equal(params.get(key.state), "state-xyz");
  assert.equal(params.get(key.redirectUri), REDIRECT_URI);
  assert.equal(params.get(key.gatewayId), "gateway-1");
  assert.equal(params.get(key.deviceName), "Kris's MacBook");
  assert.equal(params.get(key.platform), "darwin");

  // The device key is base64url-encoded so it round-trips through the sign-in
  // redirect: the raw param carries no PEM spaces/newlines, and it decodes back
  // to the exact PEM the web parser hands to the mint.
  const encodedKey = params.get(key.gatewayPublicKey) ?? "";
  assert.doesNotMatch(encodedKey, FRAGILE_CHARS_RE);
  assert.equal(
    decodeDesktopGatewayPublicKey(encodedKey),
    SAMPLE_PUBLIC_KEY_PEM
  );
});

test("redeemDesktopAuthorizationCode PoP-signs a POST to the token endpoint", async () => {
  const { signer, calls: popCalls } = popSignerStub();
  const { fetchImpl, calls } = fetchStub(
    new Response(JSON.stringify(SAMPLE_TOKENS), { status: 200 })
  );

  const result = await redeem(fetchImpl, signer);

  assert.ok(result.ok);
  assert.deepEqual(result.value, SAMPLE_TOKENS);
  assert.equal(calls[0].url, `${API_ORIGIN}/desktop/authorize/token`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    code: "auth-code",
    codeVerifier: "verifier-value",
    gatewayId: "gateway-1",
    redirectUri: REDIRECT_URI,
  });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-Desktop-Signature"], "sig-value");
  assert.deepEqual(popCalls[0], {
    method: "POST",
    pathname: "/desktop/authorize/token",
  });
});

test("redeemDesktopAuthorizationCode maps a 401 to an invalid result", async () => {
  const { signer } = popSignerStub();
  const { fetchImpl } = fetchStub(
    new Response(JSON.stringify({ code: "DESKTOP_AUTHORIZE_TOKEN_INVALID" }), {
      status: 401,
    })
  );

  const result = await redeem(fetchImpl, signer);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "invalid");
  }
});

test("redeemDesktopAuthorizationCode maps a 403 to pop_rejected", async () => {
  const { signer } = popSignerStub();
  const { fetchImpl } = fetchStub(
    new Response(JSON.stringify({ code: "DESKTOP_SESSION_POP_REQUIRED" }), {
      status: 403,
    })
  );

  const result = await redeem(fetchImpl, signer);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "pop_rejected");
  }
});

test("redeemDesktopAuthorizationCode fails invalid on an incomplete token body", async () => {
  const { signer } = popSignerStub();
  const { fetchImpl } = fetchStub(
    new Response(JSON.stringify({ accessToken: "only-this" }), { status: 200 })
  );

  const result = await redeem(fetchImpl, signer);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "invalid");
  }
});
