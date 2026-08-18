import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  type DesktopSignInProvider,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import {
  type DesktopSessionResult,
  type DesktopSessionTokens,
  parseSessionTokens,
  postSignedDesktopSession,
} from "../session/desktop-session-client.js";
import type { DesktopPopSigner } from "./desktop-pop.js";

/**
 * Desktop client for the loopback OAuth authorize flow (FEA-2525 / PLN-843
 * Amendment 1): build the web authorize URL the system browser opens, and
 * redeem the returned one-time code for desktop session tokens.
 *
 * The redeem is a PoP-signed POST returning the same `DesktopSessionTokens` as
 * the session exchange, so it reuses {@link postSignedDesktopSession} +
 * {@link parseSessionTokens} rather than reimplementing the transport.
 */

/** Bare web authorize route; Clerk middleware rewrites it to the org-scoped page. */
const DESKTOP_AUTHORIZE_PATH = "/settings/integrations/desktop/authorize";
const TOKEN_PATH = "/desktop/authorize/token";

export type BuildDesktopAuthorizeUrlInput = {
  /** Web-app origin the browser opens (prod / stage / local dev). */
  webAppOrigin: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  /** The loopback `http://127.0.0.1:<port>/cb` the browser returns the code to. */
  redirectUri: string;
  gatewayId: string;
  gatewayPublicKeyPem: string;
  /** Non-secret device metadata shown on the consent screen. */
  deviceName: string;
  platform: string;
  /**
   * ISS-5112: the social provider picked in the desktop UI, forwarded so a
   * signed-out person is not asked to choose a second time. Omitted entirely
   * when absent — never serialized as an empty or `null` value, per the
   * cross-repo rule that an absent optional field stays absent.
   */
  provider?: DesktopSignInProvider;
};

/**
 * Build the authorize URL. Query-param keys come from the shared
 * {@link DESKTOP_AUTHORIZE_QUERY_PARAMS} contract so they cannot drift from the
 * web page's parser (`packages/app/onboarding/lib/desktop-authorize-params.ts`).
 * The device key is base64url-encoded (see {@link encodeDesktopGatewayPublicKey})
 * so its spaces/newlines survive the signed-out sign-in redirect round-trip.
 */
export function buildDesktopAuthorizeUrl(
  input: BuildDesktopAuthorizeUrlInput
): string {
  const url = new URL(DESKTOP_AUTHORIZE_PATH, input.webAppOrigin);
  const params = url.searchParams;
  params.set(DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge, input.codeChallenge);
  params.set(
    DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallengeMethod,
    input.codeChallengeMethod
  );
  params.set(DESKTOP_AUTHORIZE_QUERY_PARAMS.state, input.state);
  params.set(DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri, input.redirectUri);
  params.set(DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayId, input.gatewayId);
  params.set(
    DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayPublicKey,
    encodeDesktopGatewayPublicKey(input.gatewayPublicKeyPem)
  );
  params.set(DESKTOP_AUTHORIZE_QUERY_PARAMS.deviceName, input.deviceName);
  params.set(DESKTOP_AUTHORIZE_QUERY_PARAMS.platform, input.platform);
  if (input.provider) {
    params.set(DESKTOP_AUTHORIZE_QUERY_PARAMS.provider, input.provider);
  }
  return url.toString();
}

export type RedeemDesktopAuthorizationCodeInput = {
  apiOrigin: string;
  code: string;
  codeVerifier: string;
  gatewayId: string;
  /** Must match the `redirect_uri` bound to the code at mint. */
  redirectUri: string;
  popSigner: DesktopPopSigner;
  fetchImpl?: typeof fetch;
};

export type RedeemDesktopAuthorizationCodeFn = (
  input: RedeemDesktopAuthorizationCodeInput
) => Promise<DesktopSessionResult<DesktopSessionTokens>>;

/**
 * Redeem a one-time authorization code (+ PKCE verifier + device PoP) at
 * `POST /desktop/authorize/token` for first-party desktop session tokens. The
 * verifier and PoP are what make a leaked code inert.
 */
export function redeemDesktopAuthorizationCode(
  input: RedeemDesktopAuthorizationCodeInput
): Promise<DesktopSessionResult<DesktopSessionTokens>> {
  return postSignedDesktopSession({
    apiOrigin: input.apiOrigin,
    path: TOKEN_PATH,
    body: {
      code: input.code,
      codeVerifier: input.codeVerifier,
      gatewayId: input.gatewayId,
      redirectUri: input.redirectUri,
    },
    popSigner: input.popSigner,
    fetchImpl: input.fetchImpl,
    parse: parseSessionTokens,
  });
}
