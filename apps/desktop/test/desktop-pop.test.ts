import assert from "node:assert/strict";
import {
  createPublicKey,
  verify as cryptoVerify,
  generateKeyPairSync,
} from "node:crypto";
import { describe, test } from "node:test";
import {
  buildDesktopPopCanonicalString,
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
  normalizeDesktopPopPathname,
  signDesktopPopHeaders,
} from "../src/main/desktop-pop.js";

describe("desktop PoP signing utilities", () => {
  test("builds exact canonical string with uppercased method and pathname only", () => {
    const canonical = buildDesktopPopCanonicalString({
      method: "post",
      pathname:
        "https://api.test.com/compute-targets/local-auth/verify?x=1#frag",
      timestampSeconds: 1_713_984_000,
      gatewayId: "gateway-123",
    });

    assert.equal(
      canonical,
      "POST\n/compute-targets/local-auth/verify\n1713984000\ngateway-123"
    );
  });

  test("normalizes relative and absolute request paths", () => {
    assert.equal(
      normalizeDesktopPopPathname("/internal/api-keys/verify?x=1"),
      "/internal/api-keys/verify"
    );
    assert.equal(
      normalizeDesktopPopPathname("https://relay.test/socket.io/?EIO=4"),
      "/socket.io/"
    );
    assert.equal(normalizeDesktopPopPathname(""), "/");
  });

  test("signs Ed25519 headers that verify against the derived public key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPkcs8Pem = privateKey
      .export({
        format: "pem",
        type: "pkcs8",
      })
      .toString();
    const publicKey = createPublicKey(privateKey);

    const headers = signDesktopPopHeaders({
      method: "post",
      pathname: "/internal/api-keys/verify?ignored=true",
      timestampSeconds: 1_713_984_000,
      gatewayId: "gateway-123",
      privateKeyPkcs8Pem,
    });

    assert.equal(headers[DESKTOP_POP_GATEWAY_ID_HEADER], "gateway-123");
    assert.equal(headers[DESKTOP_POP_TIMESTAMP_HEADER], "1713984000");
    const canonical =
      "POST\n/internal/api-keys/verify\n1713984000\ngateway-123";
    const verified = cryptoVerify(
      null,
      Buffer.from(canonical, "utf-8"),
      publicKey,
      Buffer.from(headers[DESKTOP_POP_SIGNATURE_HEADER], "base64url")
    );
    assert.equal(verified, true);
  });
});
