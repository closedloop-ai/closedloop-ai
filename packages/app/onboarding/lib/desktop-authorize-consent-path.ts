import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";

/**
 * Whether `pathname` is the desktop loopback authorize/consent page (FEA-2460).
 *
 * The desktop opens this page in the browser right after sign-up, while it
 * waits on a short-lived authorization code. Anything that takes the reader
 * somewhere else first — a redirect that drops the OAuth params from the URL, a
 * blocking takeover rendered over the consent card — lets that code expire and
 * recreates the new-user dead-end the flow exists to remove. Two surfaces owe
 * the page that exemption: `OnboardingGuard`'s redirect to `/onboarding`, and
 * the web guided-onboarding takeover, which rendered the whole web wizard over
 * the consent page and delayed the hand-back by minutes (ISS-11910, ISS-11912).
 *
 * The route is reachable both org-scoped (`/{orgSlug}/settings/…`) and via the
 * bare fallback, so this matches on the shared trailing segment, read from the
 * one module that owns the path — a rename cannot leave a consumer pointing at
 * a route nobody serves.
 *
 * Constants only, no parsing dependencies: the takeover host is a client
 * component on every authenticated page.
 */
export function isDesktopAuthorizeConsentPath(pathname: string): boolean {
  return pathname.endsWith(DESKTOP_AUTHORIZE_PATHNAME);
}
