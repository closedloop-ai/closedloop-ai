import { fromBase64Url, toBase64Url } from "./base64url";

/**
 * Wire contract for the desktop loopback OAuth **authorize URL** (FEA-2525 /
 * PLN-843 Amendment 1). The desktop main process builds this URL and the web
 * authorize page parses it — two processes in two separate builds — so the
 * query-param key names are a cross-process contract that would otherwise drift
 * silently (a rename on one side compiles but breaks installed desktop builds).
 *
 * Canonicalized here (per the "never define the same contract twice" rule) so
 * `apps/desktop`'s `buildDesktopAuthorizeUrl` and `packages/app`'s
 * `parseDesktopAuthorizeParams` import the SAME keys instead of each hardcoding
 * the literals. Dependency-free (only global `btoa`/`atob`) so bundling this
 * into the Electron main process pulls in nothing else.
 */
export const DESKTOP_AUTHORIZE_QUERY_PARAMS = {
  codeChallenge: "code_challenge",
  codeChallengeMethod: "code_challenge_method",
  state: "state",
  redirectUri: "redirect_uri",
  gatewayId: "gateway_id",
  gatewayPublicKey: "gateway_public_key",
  deviceName: "device_name",
  platform: "platform",
  /**
   * ISS-5112: which social provider the person picked in the DESKTOP UI, so the
   * signed-out detour lands them on that provider's consent screen instead of a
   * second chooser they already answered once.
   *
   * OPTIONAL in both directions, deliberately. An older desktop build omits it
   * and the page behaves exactly as before; an older web build receives it and
   * ignores an unknown param, falling back to the chooser. Neither side may
   * treat its absence as an error, and the value is a HINT only — it selects a
   * sign-in strategy and carries no authority, so it is never an input to the
   * PKCE/PoP checks that actually gate the mint.
   */
  provider: "provider",
} as const;

/**
 * Social providers the desktop UI can pre-select. Email is deliberately absent:
 * it is a magic-link flow with no OAuth consent screen to skip, so there is
 * nothing for the hint to do.
 *
 * No Zod here on purpose — this module is dependency-free so bundling it into
 * the Electron main process pulls in nothing else (see the file header). The
 * validating boundary is the IPC handler, which does use Zod.
 */
export const DesktopSignInProvider = {
  GitHub: "github",
  Google: "google",
} as const;
export type DesktopSignInProvider =
  (typeof DesktopSignInProvider)[keyof typeof DesktopSignInProvider];

const DESKTOP_AUTH_PROVIDERS: readonly string[] = Object.values(
  DesktopSignInProvider
);

/** Narrow an untrusted query-string value to a known provider; null otherwise. */
export function parseDesktopSignInProvider(
  value: string | null | undefined
): DesktopSignInProvider | null {
  return value && DESKTOP_AUTH_PROVIDERS.includes(value)
    ? (value as DesktopSignInProvider)
    : null;
}

/**
 * The `gateway_public_key` value is a multi-line SPKI PEM: it carries spaces
 * (in the `-----BEGIN PUBLIC KEY-----` header/footer) and newlines between
 * lines. As a raw query-param value that survives a *direct* browser
 * navigation (the app form-decodes `+`→space and `%0A`→newline server-side),
 * but NOT the signed-out sign-in detour: Clerk re-decodes and re-navigates to
 * the URL client-side, where the browser strips literal newlines and `+` can
 * decay to a literal plus. Either mutation corrupts the PEM, and the authorize
 * mint then rejects the key with a 400. base64url carries none of those fragile
 * characters, so the key round-trips through any redirect/decode path.
 *
 * `btoa`/`atob` are globals in both the Electron main process (Node) and the
 * browser; the PEM is ASCII, so the Latin1 round-trip is exact. The mechanics
 * live in the dependency-free {@link toBase64Url}/{@link fromBase64Url} codec so
 * the same base64url logic is not re-implemented per surface; these wrappers add
 * only the gateway-key semantics (an empty decode is treated as malformed).
 */

export function encodeDesktopGatewayPublicKey(pem: string): string {
  return toBase64Url(pem);
}

/** Inverse of {@link encodeDesktopGatewayPublicKey}; null on a malformed value. */
export function decodeDesktopGatewayPublicKey(value: string): string | null {
  const decoded = fromBase64Url(value);
  return decoded && decoded.length > 0 ? decoded : null;
}
