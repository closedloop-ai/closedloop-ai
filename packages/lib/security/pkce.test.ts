import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePKCE } from "./pkce.ts";

/**
 * `generatePKCE` produces the verifier/challenge pair the Google Drive and
 * Linear OAuth starts hand to the provider and the callback later proves
 * possession of.
 *
 * Two things are checked that a shape assertion alone would miss: the
 * challenge is recomputed from the verifier with an independent SHA-256, and
 * the base64url rewriting is pinned against a fixed byte seed chosen so the
 * standard-base64 encoding contains both `+` and `/`. A pair that merely looks
 * well-formed, or one whose alphabet slipped back to standard base64, would
 * otherwise fail only at the provider's callback, far from this code.
 */

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const DASH = /-/g;
const UNDERSCORE = /_/g;

/**
 * Seeded so that BOTH the verifier's and the challenge's standard-base64
 * encodings contain `+` and `/`, which is what makes the base64url rewrite
 * observable on each of them.
 */
const FIXED_BYTES = Uint8Array.from(
  { length: 32 },
  (_unused, index) => (index + index * index + 8) % 256
);

function standardBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Decodes unpadded base64url back to bytes, independently of the encoder. */
function base64UrlBytes(value: string): Uint8Array {
  const standard = value.replace(DASH, "+").replace(UNDERSCORE, "/");
  return Uint8Array.from(atob(standard), (char) => char.charCodeAt(0));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
}

function stubRandomBytes(bytes: Uint8Array) {
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
    (target) => {
      (target as Uint8Array).set(bytes);
      return target;
    }
  );
}

describe("generatePKCE", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the S256 challenge method", async () => {
    const { codeChallengeMethod } = await generatePKCE();

    expect(codeChallengeMethod).toBe("S256");
  });

  it("emits 43-character base64url verifier and challenge", async () => {
    const { codeVerifier, codeChallenge } = await generatePKCE();

    // RFC 7636 forbids padding and the standard base64 alphabet here.
    expect(codeVerifier).toMatch(BASE64URL_43);
    expect(codeChallenge).toMatch(BASE64URL_43);
  });

  it("rewrites the standard base64 alphabet to base64url on both halves", async () => {
    // Guards the seed itself: if these characters ever stop appearing, the
    // assertions below would pass without exercising the rewrite at all.
    const verifierBase64 = standardBase64(FIXED_BYTES);
    expect(verifierBase64).toContain("+");
    expect(verifierBase64).toContain("/");

    stubRandomBytes(FIXED_BYTES);

    const { codeVerifier, codeChallenge } = await generatePKCE();

    const digest = await sha256(codeVerifier);
    expect(standardBase64(digest)).toContain("+");
    expect(standardBase64(digest)).toContain("/");

    expect(codeVerifier).toMatch(BASE64URL_43);
    expect(base64UrlBytes(codeVerifier)).toEqual(FIXED_BYTES);
    expect(codeChallenge).toMatch(BASE64URL_43);
    expect(base64UrlBytes(codeChallenge)).toEqual(digest);
  });

  it("derives the challenge as the SHA-256 of the verifier", async () => {
    const { codeVerifier, codeChallenge } = await generatePKCE();

    expect(base64UrlBytes(codeChallenge)).toEqual(await sha256(codeVerifier));
  });

  it("draws a fresh verifier on every call", async () => {
    const first = await generatePKCE();
    const second = await generatePKCE();

    // A reused verifier would let a replayed authorization code be redeemed.
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.codeChallenge).not.toBe(second.codeChallenge);
  });
});
