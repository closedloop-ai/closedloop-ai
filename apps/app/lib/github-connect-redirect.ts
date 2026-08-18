import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DesktopSignInProvider,
  parseDesktopSignInProvider,
} from "@repo/api/src/types/desktop-authorize-url";

/**
 * Routing decisions for the GitHub-first desktop connect deep link.
 *
 * The desktop opens the loopback authorize URL
 * (`/settings/integrations/desktop/authorize?…`) in the system browser. When the
 * browser has no ClosedLoop session that lands on the generic sign-in embed —
 * a continuity break, because the button the user pressed said "Connect to
 * GitHub" and the page that appears is an account-creation form.
 *
 * This module decides when to send that request to {@link GITHUB_CONNECT_PATHNAME}
 * instead, which fires the GitHub OAuth redirect immediately so the first thing
 * the user sees is GitHub's own authorize screen.
 *
 * Lives in a leaf module — like the gateway guard and `app-route-redirects` —
 * so the decision is unit-testable without standing up the Clerk middleware
 * chain. The proxy calls these and does nothing else.
 *
 * Deliberately WEB-side rather than desktop-side: installed desktop builds are
 * version-skewed and cannot be assumed to be upgraded, so keying off the URL
 * they already open means every existing build gets the new flow with no
 * desktop release. See the cross-repo compatibility rules in the root AGENTS.md.
 */

/**
 * The deep link that starts social OAuth without rendering a provider chooser.
 *
 * Still spelled `/connect/github` because GitHub is what it starts when nothing
 * says otherwise, and installed desktop builds plus in-flight browser history
 * already carry that path. Since ISS-5112 it also serves Google, selected by the
 * `provider` param rather than by a second route.
 */
export const GITHUB_CONNECT_PATHNAME = "/connect/github";

/** Query param carrying the post-authentication destination. */
export const GITHUB_CONNECT_REDIRECT_PARAM = "redirect_url";

/**
 * Bare desktop authorize path. The proxy rewrites this to the org-scoped page
 * once a session with an active org exists, so an UNAUTHENTICATED request is
 * always still on the bare form — which is exactly the case this deep link
 * intercepts.
 */
const DESKTOP_AUTHORIZE_PATHNAME = "/settings/integrations/desktop/authorize";

/**
 * Whether an unauthenticated request for `pathname` should be sent to the
 * GitHub connect deep link rather than the generic sign-in page.
 *
 * Only the desktop authorize path qualifies. Every other signed-out route keeps
 * the normal sign-in embed, which still presents GitHub as the primary CTA via
 * `githubFirstAuthPageAppearance` — this deep link is for the one entry point
 * whose originating click already named GitHub.
 */
export function shouldDeepLinkGitHubConnect(pathname: string): boolean {
  return pathname === DESKTOP_AUTHORIZE_PATHNAME;
}

/**
 * Normalize an untrusted `redirect_url` to a same-origin path, or `null` when it
 * cannot be trusted.
 *
 * This is an open-redirect boundary: the value reaches the browser as a
 * post-authentication navigation target, so a value pointing off-origin would
 * hand a freshly-authenticated session to someone else's page.
 *
 * RESOLVED, never prefix-matched. An earlier version accepted any string
 * starting with a single `/` verbatim and rejected only a literal `//` prefix.
 * That leaks: the WHATWG URL parser treats a backslash as a path separator for
 * special schemes, so `/\evil.test/steal` is NOT protocol-relative by string
 * shape but parses to the origin `https://evil.test`. Percent-encoded
 * (`%5C`), it survives Next's `searchParams` decoding and reaches here as a
 * literal backslash.
 *
 * Resolving against `appOrigin` and comparing origins collapses every hostile
 * shape into one check — `//host`, `/\host`, `/\\host`, an off-origin absolute
 * URL, and `javascript:` (which parses with a `null` origin) all fail it — and
 * it is less code than the prefix tests it replaces. The parser also strips the
 * tab/CR/LF characters that a splitting attack would rely on.
 *
 * Returns the same-origin `pathname + search`, or `null`.
 */
export function resolveGitHubConnectRedirectTarget(
  rawRedirectUrl: string | null | undefined,
  appOrigin: string
): string | null {
  if (!rawRedirectUrl) {
    return null;
  }

  const origin = safeParseUrl(appOrigin);
  if (!origin) {
    return null;
  }

  // Resolving a rooted path against the app origin is what makes the backslash
  // form observable: as a bare string it looks same-origin, as a URL it is not.
  const parsed = safeParseUrl(rawRedirectUrl, origin);
  if (!parsed || parsed.origin !== origin.origin) {
    return null;
  }

  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Build the deep-link URL for an incoming unauthenticated request, preserving
 * the full original URL (path AND query) as the post-auth destination.
 *
 * The desktop authorize query string carries the PKCE challenge, `state`, the
 * loopback `redirect_uri`, and the base64url gateway key. Losing any of it
 * strands the desktop on its loopback listener until timeout, so the whole
 * `pathname + search` rides through rather than just the path.
 */
export function buildGitHubConnectRedirectUrl(requestUrl: URL): URL {
  const target = `${requestUrl.pathname}${requestUrl.search}`;
  // Built from the REQUEST origin, not the configured app URL, so Vercel
  // preview deploys redirect within themselves instead of bouncing to prod.
  const deepLink = new URL(GITHUB_CONNECT_PATHNAME, requestUrl.origin);
  deepLink.searchParams.set(GITHUB_CONNECT_REDIRECT_PARAM, target);

  // ISS-5112: the desktop already asked which provider the person wanted, so
  // carry that answer forward instead of restarting GitHub for everyone. It
  // rides as its own param rather than being re-read out of the nested
  // `redirect_url`, so the deep link is self-describing and the page never has
  // to parse a URL inside a URL to know which flow to start.
  //
  // Set ONLY when the incoming URL named a provider we recognize: an older
  // desktop build omits it entirely, and omission has to keep meaning GitHub.
  const provider = parseDesktopSignInProvider(
    requestUrl.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.provider)
  );
  if (provider) {
    deepLink.searchParams.set(
      DESKTOP_AUTHORIZE_QUERY_PARAMS.provider,
      provider
    );
  }

  return deepLink;
}

/**
 * Where an unresolvable or untrusted `redirect_url` falls back to. Both
 * transitional routes share it so they cannot drift apart on the one value that
 * decides where a rejected target sends the user.
 */
export const GITHUB_CONNECT_DEFAULT_TARGET = "/";

/**
 * Read and validate `redirect_url` straight off a Next `searchParams` bag.
 *
 * Both `/connect/github` and `/sso-callback` need the identical sequence —
 * unwrap the `string | string[] | undefined` a repeated query key produces,
 * resolve it through the open-redirect boundary above, fall back to
 * {@link GITHUB_CONNECT_DEFAULT_TARGET} — and each had its own copy. That is
 * the part most likely to need a fix (a future array-shape rule, a different
 * default), so it belongs in the module that already owns this decision rather
 * than at two call sites that would silently diverge.
 *
 * Takes the FIRST value of a repeated key, deliberately: an attacker who can
 * append `?redirect_url=` a second time must not be able to displace the real
 * one. The resolver validates whichever value wins regardless.
 */
export function resolveGitHubConnectRedirectFromSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
  appOrigin: string
): string {
  const raw = searchParams[GITHUB_CONNECT_REDIRECT_PARAM];
  const rawRedirectUrl = Array.isArray(raw) ? raw[0] : raw;

  return (
    resolveGitHubConnectRedirectTarget(rawRedirectUrl, appOrigin) ??
    GITHUB_CONNECT_DEFAULT_TARGET
  );
}

/**
 * Which provider's OAuth flow the connect deep link should start.
 *
 * Defaults to GitHub, deliberately. The param is a HINT sent by a version-skewed
 * desktop build, so "absent" and "unrecognized" both have to mean the flow this
 * route has always started; only an explicit, known value diverges. It carries
 * no authority either — it picks a sign-in strategy and is never an input to the
 * PKCE/PoP checks that actually gate the authorize mint.
 *
 * Takes the FIRST value of a repeated key, matching
 * {@link resolveGitHubConnectRedirectFromSearchParams}, so a second appended
 * copy cannot displace the real one.
 */
export function resolveDesktopSignInProviderFromSearchParams(
  searchParams: Record<string, string | string[] | undefined>
): DesktopSignInProvider {
  const raw = searchParams[DESKTOP_AUTHORIZE_QUERY_PARAMS.provider];
  const rawProvider = Array.isArray(raw) ? raw[0] : raw;

  return (
    parseDesktopSignInProvider(rawProvider) ?? DesktopSignInProvider.GitHub
  );
}

function safeParseUrl(value: string, base?: URL): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** The standard sign-in route, used as the manual recovery destination. */
const SIGN_IN_PATHNAME = "/sign-in";

/**
 * Hard ceiling on either transitional route before it offers a manual way out.
 *
 * Shared so the two stops cannot drift: `/sso-callback` shipped without one at
 * first, which left a user whose handshake stalled watching a spinner with no
 * recovery — on the LATER stop, after they had already spent the whole GitHub
 * round trip and with their desktop app sitting on a loopback listener. Ten
 * seconds is generous for a redirect and short enough to still feel like the
 * page noticed.
 */
export const AUTH_TRANSITION_TIMEOUT_MS = 10_000;

/**
 * Provider name for the words on screen, shared by both transitional routes.
 *
 * One map rather than a copy per route: `/connect/github` and `/sso-callback`
 * are consecutive stops in the same flow, and a Google user told to "pick
 * GitHub" on either one is the same wrong-door bug. Exhaustive over
 * {@link DesktopSignInProvider}, so a new provider fails `tsc` here.
 */
export const DESKTOP_SIGN_IN_PROVIDER_LABEL = {
  [DesktopSignInProvider.GitHub]: "GitHub",
  [DesktopSignInProvider.Google]: "Google",
} as const satisfies Record<DesktopSignInProvider, string>;

/**
 * Manual recovery link for a stalled transition: the standard sign-in page,
 * carrying the same post-auth destination so a user who falls back still
 * returns to the desktop authorize consent rather than the app root.
 */
export function buildSignInFallbackHref(target: string): string {
  if (target === GITHUB_CONNECT_DEFAULT_TARGET) {
    return SIGN_IN_PATHNAME;
  }
  return `${SIGN_IN_PATHNAME}?${GITHUB_CONNECT_REDIRECT_PARAM}=${encodeURIComponent(target)}`;
}
