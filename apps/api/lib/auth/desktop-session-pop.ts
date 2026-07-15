import "server-only";

import { verify as verifySignature } from "node:crypto";
import {
  BASE64URL_SIGNATURE_PATTERN,
  createEd25519PublicKey,
  POP_TIMESTAMP_FRESHNESS_SECONDS,
  readDesktopPopHeaders,
  TIMESTAMP_SECONDS_PATTERN,
} from "./desktop-pop-utils";

/**
 * Device proof-of-possession verification for first-party desktop sessions
 * (FEA-1514 / FEA-2216). Mirrors the desktop-managed-PoP canonical
 * (`METHOD\nPATH\nTIMESTAMP\nGATEWAY_ID`) and Ed25519 verification, but is
 * decoupled from API-key context so it can gate desktop-session exchange,
 * refresh, and revoke. The signature proves possession of the device private
 * key bound to the session; a stolen refresh token alone is therefore not
 * sufficient to mint a new access token.
 *
 * This module never logs or returns signature, secret, or token material.
 */

export type DesktopSessionPopReason =
  | "passed"
  | "missing_headers"
  | "malformed_headers"
  | "stale_timestamp"
  | "gateway_mismatch"
  | "invalid_signature"
  | "verifier_unavailable";

export type DesktopSessionPopResult = {
  ok: boolean;
  reason: DesktopSessionPopReason;
};

export type VerifyDesktopSessionPopInput = {
  request: Request;
  /** PEM-encoded Ed25519 SPKI public key the session is bound to. */
  boundPublicKeyPem: string;
  /** Gateway/device id the request must be signed for. */
  expectedGatewayId: string;
  now?: Date;
};

export function verifyDesktopSessionPop(
  input: VerifyDesktopSessionPopInput
): DesktopSessionPopResult {
  const publicKey = createEd25519PublicKey(input.boundPublicKeyPem);
  if (!publicKey) {
    return { ok: false, reason: "verifier_unavailable" };
  }

  const headers = readDesktopPopHeaders(input.request.headers);
  if (!(headers.gatewayId && headers.timestamp && headers.signature)) {
    return { ok: false, reason: "missing_headers" };
  }

  if (
    !(
      TIMESTAMP_SECONDS_PATTERN.test(headers.timestamp) &&
      BASE64URL_SIGNATURE_PATTERN.test(headers.signature)
    )
  ) {
    return { ok: false, reason: "malformed_headers" };
  }

  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { ok: false, reason: "malformed_headers" };
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (
    Math.abs(nowSeconds - timestampSeconds) > POP_TIMESTAMP_FRESHNESS_SECONDS
  ) {
    return { ok: false, reason: "stale_timestamp" };
  }

  if (headers.gatewayId !== input.expectedGatewayId) {
    return { ok: false, reason: "gateway_mismatch" };
  }

  let pathname: string;
  let signature: Buffer;
  try {
    pathname = new URL(input.request.url).pathname || "/";
    signature = Buffer.from(headers.signature, "base64url");
  } catch {
    return { ok: false, reason: "verifier_unavailable" };
  }

  const canonical = [
    input.request.method.toUpperCase(),
    pathname,
    headers.timestamp,
    headers.gatewayId,
  ].join("\n");

  try {
    const valid = verifySignature(
      null,
      Buffer.from(canonical, "utf8"),
      publicKey,
      signature
    );
    return valid
      ? { ok: true, reason: "passed" }
      : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "verifier_unavailable" };
  }
}
