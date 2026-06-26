import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, test } from "node:test";
import {
  buildBootstrapClaimPayload,
  claimDesktopManagedApiKey,
  isRetryableBootstrapClaimFailure,
} from "../src/main/bootstrap-claim.js";
import type { GatewaySigningKeyMaterial } from "../src/main/gateway-signing-key-store.js";

function makeKeyMaterial(gatewayId: string): GatewaySigningKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    gatewayId,
    privateKeyPkcs8Pem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKeySpkiPem: publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
  };
}

describe("bootstrap claim", () => {
  test("builds the exact preferred claim payload", () => {
    const payload = buildBootstrapClaimPayload({
      onboardingAttemptId: " attempt-1 ",
      webAppOrigin: " https://app.test ",
      gatewayId: " gateway-1 ",
      gatewayPublicKeyPem:
        " -----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY----- ",
    });

    assert.deepEqual(payload, {
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      gatewayPublicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
    });
  });

  test("sends gatewayPublicKeyPem and only the preferred body fields on managed claim", async () => {
    const keyPair = makeKeyMaterial("gateway-1");
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const result = await claimDesktopManagedApiKey({
      apiOrigin: "https://api.test",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      bootstrapToken: "bootstrap-jwt",
      signingKeys: {
        getOrCreate: () => ({ ok: true, keyPair }),
      },
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            success: true,
            data: { apiKey: "sk_live_managed" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      },
    });

    assert.deepEqual(result, { kind: "claimed", apiKey: "sk_live_managed" });
    assert.equal(capturedUrl, "https://api.test/desktop/bootstrap/claim");
    assert.ok(capturedInit, "fetch init should be captured");
    const headers = new Headers(capturedInit!.headers);
    assert.equal(headers.get("Authorization"), "Bearer bootstrap-jwt");
    assert.equal(headers.get("Content-Type"), "application/json");
    const body = JSON.parse(capturedInit!.body as string) as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "gatewayId",
        "gatewayPublicKeyPem",
        "onboardingAttemptId",
        "webAppOrigin",
      ].sort()
    );
    assert.equal(body.gatewayPublicKeyPem, keyPair.publicKeySpkiPem.trim());
  });

  test("does not call claim endpoint when public key export is unavailable", async () => {
    let fetchCalled = false;
    const diagnostics: unknown[] = [];

    const result = await claimDesktopManagedApiKey({
      apiOrigin: "https://api.test",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      signingKeys: {
        getOrCreate: () => ({ ok: false, reason: "safe_storage_unavailable" }),
      },
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    assert.deepEqual(result, {
      kind: "manual_fallback",
      reason: "safe_storage_unavailable",
    });
    assert.equal(fetchCalled, false);
    assert.deepEqual(diagnostics, [
      {
        surface: "bootstrap_claim",
        reason: "safe_storage_unavailable",
      },
    ]);
  });

  test("invalid claim payload returns failed without a misleading key diagnostic", async () => {
    const keyPair = makeKeyMaterial("gateway-1");
    let fetchCalled = false;
    const diagnostics: unknown[] = [];

    const result = await claimDesktopManagedApiKey({
      apiOrigin: "https://api.test",
      onboardingAttemptId: " ",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      signingKeys: {
        getOrCreate: () => ({ ok: true, keyPair }),
      },
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    assert.equal(fetchCalled, false);
    assert.equal(diagnostics.length, 0);
    assert.deepEqual(result, {
      kind: "failed",
      error:
        "bootstrap claim requires onboardingAttemptId, webAppOrigin, gatewayId, and gatewayPublicKeyPem",
    });
  });

  test("invalid apiOrigin returns failed instead of throwing", async () => {
    const keyPair = makeKeyMaterial("gateway-1");
    let fetchCalled = false;

    const result = await claimDesktopManagedApiKey({
      apiOrigin: "",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      signingKeys: {
        getOrCreate: () => ({ ok: true, keyPair }),
      },
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    });

    assert.equal(fetchCalled, false);
    assert.deepEqual(result, {
      kind: "failed",
      error: "invalid apiOrigin",
    });
  });

  test("retry predicate honors explicit claim retryable contract values", () => {
    assert.equal(
      isRetryableBootstrapClaimFailure({
        kind: "failed",
        statusCode: 503,
        retryable: false,
        error: "attempt already consumed",
      }),
      false
    );
    assert.equal(
      isRetryableBootstrapClaimFailure({
        kind: "failed",
        statusCode: 503,
        retryable: true,
        error: "temporary outage",
      }),
      true
    );
    assert.equal(
      isRetryableBootstrapClaimFailure({
        kind: "failed",
        statusCode: 503,
        error: "legacy temporary outage",
      }),
      true
    );
    assert.equal(
      isRetryableBootstrapClaimFailure({
        kind: "failed",
        statusCode: 409,
        error: "conflict",
      }),
      false
    );
  });
});
