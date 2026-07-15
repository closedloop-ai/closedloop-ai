import { describe, expect, it } from "vitest";
import {
  isSupportedPkceMethod,
  isValidS256CodeChallenge,
  PKCE_CODE_CHALLENGE_METHOD,
  verifyPkceS256,
} from "./pkce";

// Canonical RFC 7636 Appendix B example pair.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("verifyPkceS256", () => {
  it("accepts the matching verifier/challenge (RFC 7636 example)", () => {
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it("rejects a verifier that does not hash to the challenge", () => {
    expect(
      verifyPkceS256(
        "wrongVerifierwrongVerifierwrongVerifierwrong",
        RFC_CHALLENGE
      )
    ).toBe(false);
  });

  it("rejects a verifier outside the RFC 7636 length bounds (43–128)", () => {
    expect(verifyPkceS256("a".repeat(42), RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256("a".repeat(129), RFC_CHALLENGE)).toBe(false);
  });

  it("rejects a verifier with characters outside the unreserved set", () => {
    // '+' and '/' are base64 (not base64url) and not in the PKCE unreserved set.
    expect(verifyPkceS256(`${"a".repeat(42)}+`, RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256(`${"a".repeat(42)}/`, RFC_CHALLENGE)).toBe(false);
  });

  it("rejects a challenge of the wrong length without throwing", () => {
    expect(verifyPkceS256(RFC_VERIFIER, "tooshort")).toBe(false);
  });
});

describe("isSupportedPkceMethod", () => {
  it("accepts only S256", () => {
    expect(isSupportedPkceMethod(PKCE_CODE_CHALLENGE_METHOD)).toBe(true);
    expect(isSupportedPkceMethod("plain")).toBe(false);
    expect(isSupportedPkceMethod("")).toBe(false);
  });
});

describe("isValidS256CodeChallenge", () => {
  it("accepts a base64url 32-byte digest and rejects malformed challenges", () => {
    expect(isValidS256CodeChallenge(RFC_CHALLENGE)).toBe(true);
    expect(isValidS256CodeChallenge("tooshort")).toBe(false);
    // base64 padding / non-url chars are not valid base64url.
    expect(isValidS256CodeChallenge(`${"A".repeat(42)}=`)).toBe(false);
    expect(isValidS256CodeChallenge(`${"A".repeat(42)}+`)).toBe(false);
  });
});
