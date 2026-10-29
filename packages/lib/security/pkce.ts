/**
 * PKCE (RFC 7636) verifier and S256 challenge generation for the OAuth
 * integrations that start an authorization-code flow from the web app
 * (Google Drive and Linear). Web Crypto only, so it runs in any runtime that
 * exposes `crypto.getRandomValues` and `crypto.subtle`.
 */

export type PKCEChallenge = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

/**
 * Generate a PKCE code verifier and challenge.
 * Uses cryptographically secure random bytes and SHA-256 hashing.
 */
export async function generatePKCE(): Promise<PKCEChallenge> {
  // Generate a random 32-byte code verifier (encoded as base64url, ~43 chars)
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  // Convert to base64url encoding
  const codeVerifier = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  // Generate SHA-256 hash of the verifier
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // Convert hash to base64url encoding
  const hashArray = new Uint8Array(hashBuffer);
  const codeChallenge = btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}
