import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
} from "@repo/api/src/types/api-key";
import { describe, expect, it } from "vitest";
import { verifyDesktopSessionPop } from "../desktop-session-pop";

const REQUEST_URL = "https://api.test/desktop/session/exchange";
const GATEWAY_ID = "gateway-1";
const TIMESTAMP_SECONDS = 1_780_000_000;

function makeKeypair(): { publicKeyPem: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKey,
  };
}

function buildSignedRequest(opts: {
  privateKey: KeyObject;
  gatewayId?: string;
  timestampSeconds?: number;
  method?: string;
}): Request {
  const method = opts.method ?? "POST";
  const gatewayId = opts.gatewayId ?? GATEWAY_ID;
  const timestamp = String(opts.timestampSeconds ?? TIMESTAMP_SECONDS);
  const pathname = new URL(REQUEST_URL).pathname;
  const canonical = [method.toUpperCase(), pathname, timestamp, gatewayId].join(
    "\n"
  );
  const signature = sign(
    null,
    Buffer.from(canonical, "utf8"),
    opts.privateKey
  ).toString("base64url");
  return new Request(REQUEST_URL, {
    method,
    headers: {
      [DESKTOP_POP_GATEWAY_ID_HEADER]: gatewayId,
      [DESKTOP_POP_TIMESTAMP_HEADER]: timestamp,
      [DESKTOP_POP_SIGNATURE_HEADER]: signature,
    },
  });
}

const now = new Date(TIMESTAMP_SECONDS * 1000);

describe("verifyDesktopSessionPop", () => {
  it("passes for a request signed by the bound device key", () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const result = verifyDesktopSessionPop({
      request: buildSignedRequest({ privateKey }),
      boundPublicKeyPem: publicKeyPem,
      expectedGatewayId: GATEWAY_ID,
      now,
    });
    expect(result).toEqual({ ok: true, reason: "passed" });
  });

  it("rejects a signature made by a different key", () => {
    const { publicKeyPem } = makeKeypair();
    const attacker = makeKeypair();
    const result = verifyDesktopSessionPop({
      request: buildSignedRequest({ privateKey: attacker.privateKey }),
      boundPublicKeyPem: publicKeyPem,
      expectedGatewayId: GATEWAY_ID,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a gateway mismatch", () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const result = verifyDesktopSessionPop({
      request: buildSignedRequest({ privateKey, gatewayId: "other-gateway" }),
      boundPublicKeyPem: publicKeyPem,
      expectedGatewayId: GATEWAY_ID,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "gateway_mismatch" });
  });

  it("rejects a stale timestamp", () => {
    const { publicKeyPem, privateKey } = makeKeypair();
    const result = verifyDesktopSessionPop({
      request: buildSignedRequest({ privateKey }),
      boundPublicKeyPem: publicKeyPem,
      expectedGatewayId: GATEWAY_ID,
      now: new Date((TIMESTAMP_SECONDS + 120) * 1000),
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects when PoP headers are missing", () => {
    const { publicKeyPem } = makeKeypair();
    const result = verifyDesktopSessionPop({
      request: new Request(REQUEST_URL, { method: "POST" }),
      boundPublicKeyPem: publicKeyPem,
      expectedGatewayId: GATEWAY_ID,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("reports verifier_unavailable for a non-Ed25519 bound key", () => {
    const { privateKey } = makeKeypair();
    const result = verifyDesktopSessionPop({
      request: buildSignedRequest({ privateKey }),
      boundPublicKeyPem: "not a pem",
      expectedGatewayId: GATEWAY_ID,
      now,
    });
    expect(result).toEqual({ ok: false, reason: "verifier_unavailable" });
  });
});
