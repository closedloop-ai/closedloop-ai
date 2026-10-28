import assert from "node:assert/strict";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import { describe, test } from "vitest";
import type { DesktopPopHeaders } from "../src/main/auth/desktop-pop.js";
import { provisionManagedKey } from "../src/main/auth/managed-key-provision.js";
import {
  resetDesktopClientAttribution,
  setDesktopClientAttributionResolver,
} from "../src/main/util/desktop-client-attribution-provider.js";

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

  /**
   * ISS-8749: managed-key provisioning is a first-party cl-api POST that builds
   * its own `RequestInit`, so it stamps itself — the read chokepoint
   * (`fetchJsonAndParse`) cannot cover it. Untouched, this lane's authenticated
   * request span was indistinguishable from one made by an old Desktop build.
   */
  test("stamps the published Desktop client attribution", async () => {
    resetDesktopClientAttribution();
    setDesktopClientAttributionResolver(() => ({
      installationId: "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311",
      clientVersion: "1.24.3",
    }));
    let capturedInit: RequestInit | undefined;

    await provisionManagedKey({
      apiOrigin: "https://api.test",
      gatewayId: GATEWAY_ID,
      gatewayPublicKeyPem: DEVICE_PEM,
      accessToken: "desktop-session-jwt",
      popSigner: () => okPopSigner(),
      fetchImpl: (_url, init) => {
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

    const headers = new Headers(capturedInit?.headers);
    assert.equal(
      headers.get(DesktopClientAttributionHeader.InstallationId),
      "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311"
    );
    assert.equal(
      headers.get(DesktopClientAttributionHeader.ClientVersion),
      "1.24.3"
    );
    // The PoP headers this lane authenticates with must survive the merge.
    assert.equal(headers.get("X-Desktop-Signature"), "sig");
    resetDesktopClientAttribution();
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
