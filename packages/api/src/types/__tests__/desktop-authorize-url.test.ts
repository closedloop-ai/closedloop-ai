import { describe, expect, it } from "vitest";
import { toBase64Url } from "../base64url";
import {
  DesktopSignInFraming,
  DesktopSignInMethod,
  DesktopSignInProvider,
  decodeDesktopEmailHint,
  decodeDesktopGatewayPublicKey,
  encodeDesktopEmailHint,
  encodeDesktopGatewayPublicKey,
  parseDesktopSignInFraming,
  parseDesktopSignInMethod,
  providerForSignInMethod,
} from "../desktop-authorize-url";

// A multi-line SPKI PEM: header/footer spaces, inter-line newlines, and a body
// with the standard-base64 `+`, `/`, and `=` — every character that corrupts a
// raw PEM carried through the desktop authorize URL's sign-in redirect.
const PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAabc123+/def==\n-----END PUBLIC KEY-----";

// Characters a redirect/decode hop can mangle: +, /, =, space, newlines.
const FRAGILE_CHARS_RE = /[+/= \n\r]/;

describe("encodeDesktopGatewayPublicKey / decodeDesktopGatewayPublicKey", () => {
  it("round-trips a multi-line PEM byte-for-byte", () => {
    expect(
      decodeDesktopGatewayPublicKey(encodeDesktopGatewayPublicKey(PEM))
    ).toBe(PEM);
  });

  it("emits a URL-safe value with no character a redirect can mangle", () => {
    // No +, /, =, space, or newline — the exact characters that break a raw PEM
    // carried through the signed-out sign-in redirect round-trip.
    expect(encodeDesktopGatewayPublicKey(PEM)).not.toMatch(FRAGILE_CHARS_RE);
  });

  it("survives the query-decode transforms that corrupt a raw PEM", () => {
    // A raw PEM loses its newlines (browsers strip them from URLs) and has its
    // spaces decay to '+' on a decodeURIComponent-style hop. base64url has
    // neither, so those transforms are no-ops and the key still decodes.
    const encoded = encodeDesktopGatewayPublicKey(PEM);
    const afterRedirectHops = encoded.replaceAll("\n", "").replaceAll(" ", "+");
    expect(afterRedirectHops).toBe(encoded);
    expect(decodeDesktopGatewayPublicKey(afterRedirectHops)).toBe(PEM);
  });

  it("returns null for a value that is not valid base64url", () => {
    expect(decodeDesktopGatewayPublicKey("%%% not base64url %%%")).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(decodeDesktopGatewayPublicKey("")).toBeNull();
  });
});

describe("parseDesktopSignInMethod", () => {
  // ISS-5954 M2: the widened wire vocabulary — email is a first-class value
  // alongside the two social providers.
  it("accepts every known method, email included", () => {
    expect(parseDesktopSignInMethod("github")).toBe(DesktopSignInMethod.GitHub);
    expect(parseDesktopSignInMethod("google")).toBe(DesktopSignInMethod.Google);
    expect(parseDesktopSignInMethod("email")).toBe(DesktopSignInMethod.Email);
  });

  // Absent and garbage both resolve to null so the CALLER can default them to
  // GitHub — the version-skew contract for a hint an old build never sends.
  it("rejects absent and unrecognized values", () => {
    expect(parseDesktopSignInMethod(null)).toBeNull();
    expect(parseDesktopSignInMethod(undefined)).toBeNull();
    expect(parseDesktopSignInMethod("")).toBeNull();
    expect(parseDesktopSignInMethod("gitlab")).toBeNull();
  });
});

describe("providerForSignInMethod", () => {
  it("maps each social method to its OAuth provider", () => {
    expect(providerForSignInMethod(DesktopSignInMethod.GitHub)).toBe(
      DesktopSignInProvider.GitHub
    );
    expect(providerForSignInMethod(DesktopSignInMethod.Google)).toBe(
      DesktopSignInProvider.Google
    );
  });

  // The branch point ISS-5954 M3 rides on: email has NO OAuth provider, so the
  // landing page renders a form instead of auto-firing a consent screen.
  it("returns null for email, which has no OAuth strategy", () => {
    expect(providerForSignInMethod(DesktopSignInMethod.Email)).toBeNull();
  });
});

describe("encodeDesktopEmailHint / decodeDesktopEmailHint", () => {
  // Plus-addressing is the character the raw-query path is documented to
  // mangle — the whole reason the hint is base64url-encoded.
  it("round-trips a plus-addressed email byte-for-byte", () => {
    const email = "kerensa+desktop@closedloop.ai";
    const encoded = encodeDesktopEmailHint(email);
    expect(encoded).not.toBeNull();
    expect(decodeDesktopEmailHint(encoded)).toBe(email);
  });

  it("trims surrounding whitespace before encoding", () => {
    const encoded = encodeDesktopEmailHint("  dev@company.com  ");
    expect(decodeDesktopEmailHint(encoded)).toBe("dev@company.com");
  });

  it("refuses to encode an implausible or oversize value", () => {
    expect(encodeDesktopEmailHint("")).toBeNull();
    expect(encodeDesktopEmailHint("not-an-email")).toBeNull();
    expect(encodeDesktopEmailHint("two words@company.com")).toBeNull();
    expect(encodeDesktopEmailHint(`${"a".repeat(255)}@b.com`)).toBeNull();
  });

  // `btoa` (inside toBase64Url) throws on any code point above U+00FF. The
  // plausibility gate has to reject those addresses FIRST so an
  // internationalized address arriving over IPC degrades to "no prefill"
  // instead of failing the whole sign-in as `start_failed` — the graceful
  // omission the IPC boundary documents.
  it("returns null for non-ASCII and control-character addresses instead of throwing", () => {
    expect(encodeDesktopEmailHint("用户@example.com")).toBeNull();
    expect(encodeDesktopEmailHint("café@example.com")).toBeNull();
    expect(encodeDesktopEmailHint("a\u0000b@example.com")).toBeNull();
  });

  // The decode side narrows UNTRUSTED input: anyone can craft this URL, so a
  // value that is not base64url — or decodes to something that is not an
  // address — must die here, never reach a form field.
  it("rejects absent, malformed, and implausible incoming values", () => {
    expect(decodeDesktopEmailHint(null)).toBeNull();
    expect(decodeDesktopEmailHint(undefined)).toBeNull();
    expect(decodeDesktopEmailHint("")).toBeNull();
    expect(decodeDesktopEmailHint("%%% not base64url %%%")).toBeNull();
    expect(decodeDesktopEmailHint(toBase64Url("just words"))).toBeNull();
    // Same charset boundary as the encode side: a token that decodes to a
    // non-ASCII "address" never reaches the form field.
    expect(decodeDesktopEmailHint(toBase64Url("café@example.com"))).toBeNull();
  });
});

describe("DesktopSignInProvider ⊆ DesktopSignInMethod", () => {
  // The provider set is BY DEFINITION the OAuth subset of the method set: a
  // provider value the method parser rejects would be droppable on the deep
  // link's carry-forward hop, which now parses methods.
  it("keeps every provider value a valid method value", () => {
    for (const provider of Object.values(DesktopSignInProvider)) {
      expect(parseDesktopSignInMethod(provider)).toBe(provider);
    }
  });
});

describe("parseDesktopSignInFraming", () => {
  it("accepts only the known framings", () => {
    for (const framing of Object.values(DesktopSignInFraming)) {
      expect(parseDesktopSignInFraming(framing)).toBe(framing);
    }
  });

  it("rejects unknown, empty, and absent values", () => {
    expect(parseDesktopSignInFraming("sideways")).toBeNull();
    expect(parseDesktopSignInFraming("")).toBeNull();
    expect(parseDesktopSignInFraming(null)).toBeNull();
    expect(parseDesktopSignInFraming(undefined)).toBeNull();
  });
});
