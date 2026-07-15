import { createHash, timingSafeEqual } from "node:crypto";

/**
 * PKCE (RFC 7636) support for the desktop OAuth authorization-code flow
 * (FEA-2409 / PLN-843 Amendment 1). The desktop keeps a high-entropy
 * `code_verifier` in memory and sends only
 * `code_challenge = base64url(SHA-256(code_verifier))` through the browser; at
 * token redemption it presents the verifier, which the server hashes and
 * compares (constant time) against the stored challenge. Only the `S256` method
 * is supported — `plain` is rejected so a code observed in transit cannot be
 * redeemed without the (never-transmitted) verifier.
 */

export const PKCE_CODE_CHALLENGE_METHOD = "S256" as const;
export type PkceCodeChallengeMethod = typeof PKCE_CODE_CHALLENGE_METHOD;

/** RFC 7636 §4.1: 43–128 chars from the unreserved set `[A-Za-z0-9-._~]`. */
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 §4.2: `code_challenge` is the base64url of a 32-byte SHA-256 digest. */
const S256_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function isSupportedPkceMethod(
  method: string
): method is PkceCodeChallengeMethod {
  return method === PKCE_CODE_CHALLENGE_METHOD;
}

/** Whether `challenge` is a well-formed S256 `code_challenge` (shape only). */
export function isValidS256CodeChallenge(challenge: string): boolean {
  return S256_CHALLENGE_RE.test(challenge);
}

/**
 * Constant-time S256 verification: `base64url(SHA-256(codeVerifier))` must equal
 * `codeChallenge`. Returns false for a malformed verifier or a length/value
 * mismatch.
 */
export function verifyPkceS256(
  codeVerifier: string,
  codeChallenge: string
): boolean {
  if (!CODE_VERIFIER_RE.test(codeVerifier)) {
    return false;
  }
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  if (computed.length !== codeChallenge.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
}
