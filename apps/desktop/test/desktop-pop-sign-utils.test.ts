import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";
import {
  type DesktopPopSigningRequest,
  DesktopPopUnavailableError,
} from "../src/main/auth/desktop-pop.js";
import { signDesktopRequestWithStoredKey } from "../src/main/auth/desktop-pop-sign-utils.js";
import type { GatewaySigningKeyUnavailableReason } from "../src/main/command-signing/gateway-signing-key-store.js";

const GATEWAY_ID = "gw_test_001";
const SAMPLE_REQUEST: DesktopPopSigningRequest = {
  method: "POST",
  pathname: "/api/gateway/session",
};

function makeValidKeyPair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    gatewayId: GATEWAY_ID,
    privateKeyPkcs8Pem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKeySpkiPem: "unused-in-sign",
  };
}

const ALL_UNAVAILABLE_REASONS: GatewaySigningKeyUnavailableReason[] = [
  "gateway_id_missing",
  "key_missing",
  "safe_storage_unavailable",
  "decrypt_failed",
  "key_import_failed",
  "key_generation_failed",
];

for (const reason of ALL_UNAVAILABLE_REASONS) {
  test(`signDesktopRequestWithStoredKey propagates "${reason}" verbatim`, () => {
    assert.throws(
      () =>
        signDesktopRequestWithStoredKey({
          request: SAMPLE_REQUEST,
          gatewayId: GATEWAY_ID,
          loadKeyPair: () => ({ ok: false, reason }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof DesktopPopUnavailableError);
        assert.equal(
          error.reason,
          reason,
          `expected reason "${reason}" to propagate verbatim, got "${error.reason}"`
        );
        return true;
      }
    );
  });
}

test('signDesktopRequestWithStoredKey redacts a signing failure to "sign_failed"', () => {
  assert.throws(
    () =>
      signDesktopRequestWithStoredKey({
        request: SAMPLE_REQUEST,
        gatewayId: GATEWAY_ID,
        loadKeyPair: () => ({
          ok: true,
          keyPair: {
            gatewayId: GATEWAY_ID,
            privateKeyPkcs8Pem: "not-a-valid-pem",
            publicKeySpkiPem: "unused",
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopPopUnavailableError);
      assert.equal(
        error.reason,
        "sign_failed",
        "a signing failure must be redacted to the generic reason"
      );
      return true;
    }
  );
});

test("signDesktopRequestWithStoredKey returns well-formed headers on success", () => {
  const keyPair = makeValidKeyPair();
  const headers = signDesktopRequestWithStoredKey({
    request: SAMPLE_REQUEST,
    gatewayId: GATEWAY_ID,
    loadKeyPair: () => ({ ok: true, keyPair }),
  });

  assert.equal(typeof headers["X-Desktop-Gateway-Id"], "string");
  assert.equal(headers["X-Desktop-Gateway-Id"], GATEWAY_ID);
  assert.equal(typeof headers["X-Desktop-Timestamp"], "string");
  assert.equal(typeof headers["X-Desktop-Signature"], "string");
  assert.ok(
    headers["X-Desktop-Signature"].length > 0,
    "signature must be non-empty"
  );
});
