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
  DESKTOP_BOOTSTRAP_SUPPORTED_TRUE,
  decodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { isAllowedDesktopLoopbackRedirectUri } from "@repo/api/src/types/desktop-loopback-redirect";

export type DesktopAuthorizeParams = {
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  redirectUri: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  deviceName: string;
  platform: string;
  bootstrapSupported: boolean;
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

  if (!isAllowedDesktopLoopbackRedirectUri(redirectUri)) {
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
      bootstrapSupported:
        firstValue(
          searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.bootstrapSupported]
        ) === DESKTOP_BOOTSTRAP_SUPPORTED_TRUE,
    },
  };
}
