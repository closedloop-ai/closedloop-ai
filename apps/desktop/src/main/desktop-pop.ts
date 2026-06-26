import { createPrivateKey, sign as cryptoSign } from "node:crypto";

export const DESKTOP_POP_GATEWAY_ID_HEADER = "X-Desktop-Gateway-Id";
export const DESKTOP_POP_TIMESTAMP_HEADER = "X-Desktop-Timestamp";
export const DESKTOP_POP_SIGNATURE_HEADER = "X-Desktop-Signature";
export const RELAY_API_KEY_VERIFY_PATH = "/internal/api-keys/verify";
export const LOCAL_AUTH_VERIFY_PATH = "/compute-targets/local-auth/verify";

export type DesktopPopHeaders = Record<
  | typeof DESKTOP_POP_GATEWAY_ID_HEADER
  | typeof DESKTOP_POP_TIMESTAMP_HEADER
  | typeof DESKTOP_POP_SIGNATURE_HEADER,
  string
>;

export type DesktopPopSigningRequest = {
  method: string;
  pathname: string;
  timestampSeconds?: number;
};

export interface DesktopPopSigningInput extends DesktopPopSigningRequest {
  gatewayId: string;
  privateKeyPkcs8Pem: string;
}

export type DesktopPopSigner = (
  request: DesktopPopSigningRequest
) => DesktopPopHeaders | null | Promise<DesktopPopHeaders | null>;

/**
 * Redacted failure used to preserve precise PoP-unavailable reasons across signer callers.
 */
export class DesktopPopUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super("Desktop PoP signing unavailable");
    this.name = "DesktopPopUnavailableError";
    this.reason = reason;
  }
}

/**
 * Returns a redacted fallback reason for PoP signing failures.
 */
export function getDesktopPopUnavailableReason(error: unknown): string {
  return error instanceof DesktopPopUnavailableError
    ? error.reason
    : "sign_failed_or_null";
}

/**
 * Builds the exact canonical input expected by PRD-181 Phase B PoP verification.
 */
export function buildDesktopPopCanonicalString(input: {
  method: string;
  pathname: string;
  timestampSeconds: number | string;
  gatewayId: string;
}): string {
  return [
    input.method.toUpperCase(),
    normalizeDesktopPopPathname(input.pathname),
    String(input.timestampSeconds),
    input.gatewayId,
  ].join("\n");
}

/**
 * Signs a Desktop PoP validation request with Ed25519 and returns the wire headers.
 */
export function signDesktopPopHeaders(
  input: DesktopPopSigningInput
): DesktopPopHeaders {
  const timestampSeconds =
    input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const canonical = buildDesktopPopCanonicalString({
    method: input.method,
    pathname: input.pathname,
    timestampSeconds,
    gatewayId: input.gatewayId,
  });
  const privateKey = createPrivateKey({
    key: input.privateKeyPkcs8Pem,
    format: "pem",
    type: "pkcs8",
  });
  const signature = cryptoSign(
    null,
    Buffer.from(canonical, "utf8"),
    privateKey
  ).toString("base64url");

  return {
    [DESKTOP_POP_GATEWAY_ID_HEADER]: input.gatewayId,
    [DESKTOP_POP_TIMESTAMP_HEADER]: String(timestampSeconds),
    [DESKTOP_POP_SIGNATURE_HEADER]: signature,
  };
}

/**
 * Reduces any URL-ish value to the canonical pathname signed by Desktop PoP.
 */
export function normalizeDesktopPopPathname(value: string): string {
  if (!value.trim()) {
    return "/";
  }
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      return new URL(value).pathname || "/";
    }
    return new URL(value, "http://desktop.local").pathname || "/";
  } catch {
    return value.split(/[?#]/, 1)[0] || "/";
  }
}
