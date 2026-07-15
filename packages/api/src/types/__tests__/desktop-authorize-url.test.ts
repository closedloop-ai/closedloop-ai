import { describe, expect, it } from "vitest";
import {
  decodeDesktopGatewayPublicKey,
  encodeDesktopGatewayPublicKey,
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
