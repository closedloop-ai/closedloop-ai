import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
  LOCAL_AUTH_VERIFY_PATH,
} from "../src/main/desktop-pop.js";
import { verifyChallenge } from "../src/main/local-auth-verifier.js";

const VERIFY_URL = "https://api.test.com/compute-targets/local-auth/verify";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeFetch(status: number, body: unknown): typeof fetch {
  return async (_url, _init) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("successful verification returns { ok: true, sessionTtlSeconds: 600 }", async () => {
  globalThis.fetch = makeFetch(200, { ok: true, sessionTtlSeconds: 600 });

  const result = await verifyChallenge({
    challengeToken: "tok123",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key-abc",
  });

  assert.deepEqual(result, { ok: true, sessionTtlSeconds: 600 });
});

test("successful verification also accepts the legacy ApiResult envelope", async () => {
  globalThis.fetch = makeFetch(200, {
    success: true,
    data: { ok: true, sessionTtlSeconds: 600 },
  });

  const result = await verifyChallenge({
    challengeToken: "tok123",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key-abc",
  });

  assert.deepEqual(result, { ok: true, sessionTtlSeconds: 600 });
});

test("401 response returns { ok: false, error: ..., statusCode: 401 }", async () => {
  globalThis.fetch = makeFetch(401, { error: "unauthorized" });

  const result = await verifyChallenge({
    challengeToken: "tok123",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key-abc",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.statusCode, 401);
    assert.equal(result.error, "unauthorized");
  }
});

test("403 response returns { ok: false, error: ..., statusCode: 403 }", async () => {
  globalThis.fetch = makeFetch(403, { error: "forbidden" });

  const result = await verifyChallenge({
    challengeToken: "tok123",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key-abc",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, "forbidden");
  }
});

test("network error returns { ok: false, error: '...' }", async () => {
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  const result = await verifyChallenge({
    challengeToken: "tok123",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key-abc",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "ECONNREFUSED");
    assert.equal(result.statusCode, 502);
  }
});

test("verify sends correct Authorization and Content-Type headers", async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await verifyChallenge({
    challengeToken: "tok123",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "my-secret-key",
  });

  assert.ok(capturedInit, "fetch should have been called");
  const headers = new Headers(capturedInit!.headers as HeadersInit);
  assert.equal(headers.get("Authorization"), "Bearer my-secret-key");
  assert.equal(headers.get("Content-Type"), "application/json");
});

test("verify sends correct body with challengeToken, requestOrigin, and userAgent", async () => {
  let capturedBody: string | undefined;

  globalThis.fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await verifyChallenge({
    challengeToken: "challenge-abc",
    requestOrigin: "http://localhost:4000",
    userAgent: "Mozilla/5.0 Test",
    apiOrigin: "https://api.test.com",
    apiKey: "key-xyz",
  });

  assert.ok(capturedBody, "fetch body should have been captured");
  const parsed = JSON.parse(capturedBody!) as Record<string, string>;
  assert.equal(parsed.challengeToken, "challenge-abc");
  assert.equal(parsed.requestOrigin, "http://localhost:4000");
  assert.equal(parsed.userAgent, "Mozilla/5.0 Test");
});

test("verify omits userAgent from body when not provided", async () => {
  let capturedBody: string | undefined;

  globalThis.fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await verifyChallenge({
    challengeToken: "challenge-xyz",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key-abc",
  });

  assert.ok(capturedBody, "fetch body should have been captured");
  const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
  assert.equal(
    "userAgent" in parsed,
    false,
    "userAgent should not be present when not provided"
  );
});

test("verify sends request to the correct URL", async () => {
  let capturedUrl: string | undefined;

  globalThis.fetch = async (url, _init) => {
    capturedUrl = url as string;
    return new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await verifyChallenge({
    challengeToken: "tok",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key",
  });

  assert.equal(capturedUrl, VERIFY_URL);
});

test("unexpected response format on 200 returns { ok: false, error: 'unexpected response format' }", async () => {
  globalThis.fetch = makeFetch(200, { ok: false });

  const result = await verifyChallenge({
    challengeToken: "tok",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "key",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "unexpected response format");
  }
});

test("managed key verification adds Desktop PoP headers", async () => {
  let capturedInit: RequestInit | undefined;
  let capturedSigningRequest: unknown;

  globalThis.fetch = async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await verifyChallenge({
    challengeToken: "tok",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "managed-key",
    apiKeyProvenance: "DESKTOP_MANAGED",
    signDesktopRequest: (request) => {
      capturedSigningRequest = request;
      return {
        [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
        [DESKTOP_POP_TIMESTAMP_HEADER]: "1713984000",
        [DESKTOP_POP_SIGNATURE_HEADER]: "signature",
      };
    },
  });

  assert.deepEqual(capturedSigningRequest, {
    method: "POST",
    pathname: LOCAL_AUTH_VERIFY_PATH,
  });
  const headers = new Headers(capturedInit!.headers as HeadersInit);
  assert.equal(headers.get(DESKTOP_POP_GATEWAY_ID_HEADER), "gateway-1");
  assert.equal(headers.get(DESKTOP_POP_TIMESTAMP_HEADER), "1713984000");
  assert.equal(headers.get(DESKTOP_POP_SIGNATURE_HEADER), "signature");
});

test("manual key verification omits Desktop PoP headers and does not call signer", async () => {
  let capturedInit: RequestInit | undefined;
  let signerCalled = false;

  globalThis.fetch = async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true, sessionTtlSeconds: 600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await verifyChallenge({
    challengeToken: "tok",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "manual-key",
    apiKeyProvenance: "USER_CREATED",
    signDesktopRequest: () => {
      signerCalled = true;
      return null;
    },
  });

  assert.equal(signerCalled, false);
  const headers = new Headers(capturedInit!.headers as HeadersInit);
  assert.equal(headers.get(DESKTOP_POP_GATEWAY_ID_HEADER), null);
  assert.equal(headers.get(DESKTOP_POP_TIMESTAMP_HEADER), null);
  assert.equal(headers.get(DESKTOP_POP_SIGNATURE_HEADER), null);
});

test("managed key signing unavailable preserves existing 5xx semantics without retry", async () => {
  let fetchCalls = 0;
  const unavailableReports: Array<{ surface: string; reason: string }> = [];

  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: "temporary failure" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await verifyChallenge({
    challengeToken: "tok",
    requestOrigin: "http://localhost:3000",
    apiOrigin: "https://api.test.com",
    apiKey: "managed-key",
    apiKeyProvenance: "DESKTOP_MANAGED",
    signDesktopRequest: () => null,
    onDesktopPopUnavailable: (surface, reason) =>
      unavailableReports.push({ surface, reason }),
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(unavailableReports, [
    {
      surface: LOCAL_AUTH_VERIFY_PATH,
      reason: "sign_failed_or_null",
    },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, "temporary failure");
  }
});
