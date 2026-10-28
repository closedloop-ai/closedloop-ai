import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DESKTOP_BOOTSTRAP_SUPPORTED_TRUE,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import { parseDesktopAuthorizeParams } from "../desktop-authorize-params";

const LOOPBACK = "http://127.0.0.1:49152/cb";

// A realistic multi-line SPKI PEM: header/footer spaces + inter-line newlines.
// The desktop transmits it base64url-encoded (see encodeDesktopGatewayPublicKey);
// the parser decodes it back to this exact PEM.
const SAMPLE_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAabc123+/def==\n-----END PUBLIC KEY-----";

type SearchParams = Record<string, string | string[] | undefined>;

function validParams(overrides: SearchParams = {}): SearchParams {
  return {
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "state-123",
    redirect_uri: LOOPBACK,
    gateway_id: "gateway-1",
    gateway_public_key: encodeDesktopGatewayPublicKey(SAMPLE_PUBLIC_KEY_PEM),
    device_name: "Kerensa's MacBook",
    platform: "darwin",
    ...overrides,
  };
}

describe("parseDesktopAuthorizeParams", () => {
  it("parses a complete, loopback-bound authorize link", () => {
    const result = parseDesktopAuthorizeParams(validParams());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.params).toEqual({
      bootstrapSupported: false,
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
      state: "state-123",
      redirectUri: LOOPBACK,
      gatewayId: "gateway-1",
      gatewayPublicKeyPem: SAMPLE_PUBLIC_KEY_PEM,
      deviceName: "Kerensa's MacBook",
      platform: "darwin",
    });
  });

  it.each([
    { value: undefined, expected: false },
    { value: DESKTOP_BOOTSTRAP_SUPPORTED_TRUE, expected: true },
    { value: "0", expected: false },
    { value: "true", expected: false },
    { value: "", expected: false },
    { value: [DESKTOP_BOOTSTRAP_SUPPORTED_TRUE, "0"], expected: true },
    { value: ["0", DESKTOP_BOOTSTRAP_SUPPORTED_TRUE], expected: false },
  ])(
    "parses bootstrap capability $value as $expected",
    ({ value, expected }) => {
      const result = parseDesktopAuthorizeParams(
        validParams({
          [DESKTOP_AUTHORIZE_QUERY_PARAMS.bootstrapSupported]: value,
        })
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected ok");
      }
      expect(result.params.bootstrapSupported).toBe(expected);
    }
  );

  it("decodes the base64url device key back to its spaces-and-newlines PEM", () => {
    // Regression: a raw multi-line PEM in the query param is corrupted by the
    // signed-out sign-in redirect (newlines stripped, spaces mangled), so the
    // key is base64url-encoded on the wire and must decode back byte-for-byte.
    const result = parseDesktopAuthorizeParams(validParams());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.params.gatewayPublicKeyPem).toBe(SAMPLE_PUBLIC_KEY_PEM);
  });

  it("rejects a device key that is not valid base64url", () => {
    const result = parseDesktopAuthorizeParams(
      validParams({ gateway_public_key: "%%%not-base64url%%%" })
    );

    expect(result).toEqual({ ok: false, reason: "missing_params" });
  });

  it("defaults device metadata when absent", () => {
    const result = parseDesktopAuthorizeParams(
      validParams({ device_name: undefined, platform: undefined })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.params.deviceName).toBe("Unknown device");
    expect(result.params.platform).toBe("Unknown platform");
  });

  it("takes the first value when a param is repeated", () => {
    const result = parseDesktopAuthorizeParams(
      validParams({ state: ["s1", "s2"] })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.params.state).toBe("s1");
  });

  it("preserves an opaque state value byte-for-byte (no trimming)", () => {
    // OAuth state must round-trip to the desktop verbatim; a padded value like
    // `state=%20abc%20` must not be silently trimmed to `abc`.
    const result = parseDesktopAuthorizeParams(validParams({ state: " abc " }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.params.state).toBe(" abc ");
  });

  it.each([
    "code_challenge",
    "code_challenge_method",
    "state",
    "redirect_uri",
    "gateway_id",
    "gateway_public_key",
  ])("rejects when %s is missing", (key) => {
    const result = parseDesktopAuthorizeParams(
      validParams({ [key]: undefined })
    );

    expect(result).toEqual({ ok: false, reason: "missing_params" });
  });

  it("rejects a whitespace-only required param", () => {
    const result = parseDesktopAuthorizeParams(validParams({ state: "   " }));

    expect(result).toEqual({ ok: false, reason: "missing_params" });
  });

  it.each([
    "https://127.0.0.1:49152/cb",
    "http://localhost:49152/cb",
    "http://evil.com/cb",
    "http://127.0.0.1.evil.com/cb",
    "http://user:pass@127.0.0.1:49152/cb",
    "not-a-url",
  ])("rejects a non-loopback redirect_uri (%s)", (uri) => {
    const result = parseDesktopAuthorizeParams(
      validParams({ redirect_uri: uri })
    );

    expect(result).toEqual({ ok: false, reason: "invalid_redirect_uri" });
  });
});
