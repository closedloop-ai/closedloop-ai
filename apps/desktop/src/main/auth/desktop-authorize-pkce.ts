import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

/**
 * PKCE + `state` generation for the desktop loopback OAuth flow (FEA-2525 /
 * PLN-843 Amendment 1). Pure and injectable (the RNG is a seam) so the derived
 * values can be asserted exactly in tests.
 *
 * The `code_verifier` never leaves the desktop — only its S256 `code_challenge`
 * is put on the authorize URL, and only the verifier (not the challenge) is sent
 * to the token endpoint at redeem. A leaked authorization code is therefore
 * inert without the in-memory verifier and the device private key.
 */

/** PKCE method the desktop always uses. Plain is never offered (S256 mandatory). */
export const DESKTOP_PKCE_CODE_CHALLENGE_METHOD = "S256" as const;

// 32 bytes → 43 unpadded base64url chars. Satisfies RFC 7636 §4.1 (a verifier is
// 43–128 chars from the unreserved set, which base64url is a subset of) and the
// token route's `min(43)` validator, with 256 bits of entropy.
const PKCE_VERIFIER_BYTES = 32;
const OAUTH_STATE_BYTES = 32;

export type DesktopPkce = {
  /** Secret verifier — memory-only; sent to the token endpoint at redeem. */
  codeVerifier: string;
  /** `base64url(SHA-256(codeVerifier))` — the only PKCE value on the authorize URL. */
  codeChallenge: string;
  codeChallengeMethod: typeof DESKTOP_PKCE_CODE_CHALLENGE_METHOD;
};

type RandomBytesFn = (size: number) => Buffer;

/** Generate a fresh PKCE verifier + S256 challenge pair. */
export function generateDesktopPkce(
  randomBytesImpl: RandomBytesFn = nodeRandomBytes
): DesktopPkce {
  const codeVerifier =
    randomBytesImpl(PKCE_VERIFIER_BYTES).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: DESKTOP_PKCE_CODE_CHALLENGE_METHOD,
  };
}

/** Generate an opaque, single-use `state` for CSRF/mix-up protection. */
export function generateOAuthState(
  randomBytesImpl: RandomBytesFn = nodeRandomBytes
): string {
  return randomBytesImpl(OAUTH_STATE_BYTES).toString("base64url");
}
