/**
 * Parses and validates the desktop OAuth authorize URL the desktop opens in the
 * system browser (FEA-2460 / PLN-843 Amendment 1). The desktop passes the PKCE
 * challenge, an opaque `state`, its loopback `redirect_uri`, the gateway id +
 * Ed25519 public key, and non-secret device metadata for the consent screen.
 *
 * The API (`/desktop/authorize`) remains the authoritative validator of the
 * PKCE method/challenge, the redirect-URI allowlist, and the device key. These
 * checks are fail-fast/defense-in-depth so an obviously-malformed link renders
 * a clear error before consent — and so the browser is never handed off to a
 * non-loopback `redirect_uri`.
 */

import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  decodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";

export type DesktopAuthorizeParams = {
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  redirectUri: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  deviceName: string;
  platform: string;
};

/** Why parsing the desktop authorize URL failed (const-object, not a bare union). */
export const DesktopAuthorizeParamError = {
  MissingParams: "missing_params",
  InvalidRedirectUri: "invalid_redirect_uri",
} as const;
export type DesktopAuthorizeParamError =
  (typeof DesktopAuthorizeParamError)[keyof typeof DesktopAuthorizeParamError];

export type ParseDesktopAuthorizeParamsResult =
  | { ok: true; params: DesktopAuthorizeParams }
  | { ok: false; reason: DesktopAuthorizeParamError };

/**
 * IP-literal loopback only (`127.0.0.1` / `[::1]`), mirroring the API allowlist
 * (`apps/api/lib/auth/desktop-loopback-redirect.ts`). `localhost` is rejected
 * (DNS/hosts-repointable, RFC 8252 §7.3); the API stays authoritative.
 */
const LOOPBACK_REDIRECT_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "::1",
]);

export function isLoopbackRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  return LOOPBACK_REDIRECT_HOSTNAMES.has(parsed.hostname);
}

type SearchParamValue = string | string[] | undefined;

/**
 * First value of a (possibly repeated) query param, verbatim. A value that is
 * absent or whitespace-only counts as missing, but a present value is returned
 * **untrimmed** — `state` (and the PKCE challenge) are opaque tokens that must
 * round-trip to the desktop byte-for-byte, so a padded `state=%20abc%20` must
 * come back as `" abc "`, not `"abc"`.
 */
function firstValue(value: SearchParamValue): string | null {
  const raw = Array.isArray(value) ? value.at(0) : value;
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  return raw;
}

export function parseDesktopAuthorizeParams(
  searchParams: Record<string, SearchParamValue>
): ParseDesktopAuthorizeParamsResult {
  const codeChallenge = firstValue(
    searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge]
  );
  const codeChallengeMethod = firstValue(
    searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallengeMethod]
  );
  const state = firstValue(searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.state]);
  const redirectUri = firstValue(
    searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri]
  );
  const gatewayId = firstValue(
    searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayId]
  );
  // The desktop base64url-encodes the device key so its spaces/newlines survive
  // the sign-in redirect round-trip; decode it back to the SPKI PEM the mint
  // expects (`encodeDesktopGatewayPublicKey` in the shared contract).
  const gatewayPublicKeyParam = firstValue(
    searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayPublicKey]
  );

  if (
    !(
      codeChallenge &&
      codeChallengeMethod &&
      state &&
      redirectUri &&
      gatewayId &&
      gatewayPublicKeyParam
    )
  ) {
    return { ok: false, reason: DesktopAuthorizeParamError.MissingParams };
  }

  const gatewayPublicKeyPem = decodeDesktopGatewayPublicKey(
    gatewayPublicKeyParam
  );
  if (!gatewayPublicKeyPem) {
    return { ok: false, reason: DesktopAuthorizeParamError.MissingParams };
  }

  if (!isLoopbackRedirectUri(redirectUri)) {
    return { ok: false, reason: DesktopAuthorizeParamError.InvalidRedirectUri };
  }

  return {
    ok: true,
    params: {
      codeChallenge,
      codeChallengeMethod,
      state,
      redirectUri,
      gatewayId,
      gatewayPublicKeyPem,
      deviceName:
        firstValue(searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.deviceName]) ??
        "Unknown device",
      platform:
        firstValue(searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.platform]) ??
        "Unknown platform",
    },
  };
}
