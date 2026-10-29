/**
 * @file bootstrap-claim-cov-iss11283-failure-paths.test.ts
 * @description ISS-11283 lane F — branch coverage for `bootstrap-claim.ts`'s
 * non-2xx response mapping (`extractDesktopContractError`, the failed-result
 * spread branches, and `extractApiKey`'s empty-payload path), the
 * `fetchImpl`-omitted fallback to the global `fetch`, and
 * `isRetryableBootstrapClaimFailure`'s non-"failed" short-circuit — none of
 * which the existing `bootstrap-claim.test.ts` reaches.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, test } from "vitest";
import type { GatewaySigningKeyMaterial } from "../src/main/command-signing/gateway-signing-key-store.js";
import {
  claimDesktopManagedApiKey,
  isRetryableBootstrapClaimFailure,
} from "../src/main/onboarding/bootstrap-claim.js";

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

describe("isRetryableBootstrapClaimFailure", () => {
  test("is never retryable for a non-failed result", () => {
    assert.equal(
      isRetryableBootstrapClaimFailure({
        kind: "claimed",
        apiKey: "sk_live_x",
      }),
      false
    );
    assert.equal(
      isRetryableBootstrapClaimFailure({
        kind: "manual_fallback",
        reason: "safe_storage_unavailable",
      }),
      false
    );
  });
});

describe("claimDesktopManagedApiKey non-2xx response mapping", () => {
  test("carries a contract code and retryable flag from a coded failure body", async () => {
    const keyPair = makeKeyMaterial("gateway-1");

    const result = await claimDesktopManagedApiKey({
      apiOrigin: "https://api.test",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      signingKeys: {
        getOrCreate: () => ({ ok: true, keyPair }),
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            code: "RATE_LIMITED",
            retryable: true,
            error: "Too many requests",
          }),
          { status: 429 }
        ),
    });

    assert.deepEqual(result, {
      kind: "failed",
      statusCode: 429,
      code: "RATE_LIMITED",
      retryable: true,
      error: "Too many requests",
    });
  });

  test("omits code and retryable and falls back to a status-templated error for a bare failure body", async () => {
    const keyPair = makeKeyMaterial("gateway-1");

    const result = await claimDesktopManagedApiKey({
      apiOrigin: "https://api.test",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      signingKeys: {
        getOrCreate: () => ({ ok: true, keyPair }),
      },
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 503 }),
    });

    assert.deepEqual(result, {
      kind: "failed",
      statusCode: 503,
      error: "bootstrap claim failed (503)",
    });
  });

  test("returns failed when a 2xx response has no apiKey field", async () => {
    const keyPair = makeKeyMaterial("gateway-1");

    const result = await claimDesktopManagedApiKey({
      apiOrigin: "https://api.test",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      signingKeys: {
        getOrCreate: () => ({ ok: true, keyPair }),
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
        }),
    });

    assert.deepEqual(result, {
      kind: "failed",
      statusCode: 200,
      error: "bootstrap claim response missing apiKey",
    });
  });
});

describe("claimDesktopManagedApiKey fetchImpl default", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("falls back to the global fetch when fetchImpl is not provided", async () => {
    const keyPair = makeKeyMaterial("gateway-1");
    let calledUrl = "";
    globalThis.fetch = ((input: string | URL | Request) => {
      calledUrl = String(input);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: { apiKey: "sk_live_global" },
          }),
          { status: 200 }
        )
      );
    }) as typeof fetch;

    const result = await claimDesktopManagedApiKey({
      apiOrigin: "https://api.test",
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.test",
      gatewayId: "gateway-1",
      signingKeys: {
        getOrCreate: () => ({ ok: true, keyPair }),
      },
    });

    assert.deepEqual(result, { kind: "claimed", apiKey: "sk_live_global" });
    assert.equal(calledUrl, "https://api.test/desktop/bootstrap/claim");
  });
});
