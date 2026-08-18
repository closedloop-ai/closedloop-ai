import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DesktopPopHeaders } from "../src/main/auth/desktop-pop.js";
import { provisionManagedKey } from "../src/main/auth/managed-key-provision.js";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_PEM = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
const POP_HEADERS: DesktopPopHeaders = {
  "X-Desktop-Gateway-Id": GATEWAY_ID,
  "X-Desktop-Timestamp": "1700000000",
  "X-Desktop-Signature": "sig",
};

function okPopSigner(): DesktopPopHeaders {
  return { ...POP_HEADERS };
}

describe("provisionManagedKey", () => {
  test("sends the session Bearer token, PoP headers, and device pubkey body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const result = await provisionManagedKey({
      apiOrigin: "https://api.test",
      gatewayId: GATEWAY_ID,
      gatewayPublicKeyPem: DEVICE_PEM,
      accessToken: "desktop-session-jwt",
      popSigner: () => okPopSigner(),
      fetchImpl: (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: { apiKey: "sk_live_managed" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      },
    });

    assert.deepEqual(result, {
      kind: "provisioned",
      apiKey: "sk_live_managed",
    });
    assert.equal(capturedUrl, "https://api.test/desktop/managed-key/provision");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("Authorization"), "Bearer desktop-session-jwt");
    assert.equal(headers.get("X-Desktop-Signature"), "sig");
    const body = JSON.parse(capturedInit?.body as string) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(body).sort(), [
      "gatewayId",
      "gatewayPublicKeyPem",
    ]);
    assert.equal(body.gatewayId, GATEWAY_ID);
    assert.equal(body.gatewayPublicKeyPem, DEVICE_PEM);
  });

  test("returns pop_unavailable without a network call when the signer yields no headers", async () => {
    let fetchCalled = false;
    const result = await provisionManagedKey({
      apiOrigin: "https://api.test",
      gatewayId: GATEWAY_ID,
      gatewayPublicKeyPem: DEVICE_PEM,
      accessToken: "desktop-session-jwt",
      popSigner: () => null,
      fetchImpl: () => {
        fetchCalled = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });

    assert.deepEqual(result, { kind: "pop_unavailable" });
    assert.equal(fetchCalled, false);
  });

  test("maps a 403 (session/PoP rejected) to a non-retryable failure", async () => {
    const result = await provisionManagedKey({
      apiOrigin: "https://api.test",
      gatewayId: GATEWAY_ID,
      gatewayPublicKeyPem: DEVICE_PEM,
      accessToken: "desktop-session-jwt",
      popSigner: () => okPopSigner(),
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ success: false, error: "forbidden" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
        ),
    });

    assert.equal(result.kind, "failed");
    if (result.kind === "failed") {
      assert.equal(result.statusCode, 403);
      assert.equal(result.retryable, false);
    }
  });

  test("maps a 409 rotation conflict to a retryable failure", async () => {
    const result = await provisionManagedKey({
      apiOrigin: "https://api.test",
      gatewayId: GATEWAY_ID,
      gatewayPublicKeyPem: DEVICE_PEM,
      accessToken: "desktop-session-jwt",
      popSigner: () => okPopSigner(),
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ success: false, error: "conflict" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          })
        ),
    });

    assert.equal(result.kind, "failed");
    if (result.kind === "failed") {
      assert.equal(result.statusCode, 409);
      assert.equal(result.retryable, true);
    }
  });

  test("fails without a network call when required inputs are missing", async () => {
    let fetchCalled = false;
    const result = await provisionManagedKey({
      apiOrigin: "https://api.test",
      gatewayId: GATEWAY_ID,
      gatewayPublicKeyPem: "  ",
      accessToken: "desktop-session-jwt",
      popSigner: () => okPopSigner(),
      fetchImpl: () => {
        fetchCalled = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });

    assert.equal(result.kind, "failed");
    assert.equal(fetchCalled, false);
  });
});
