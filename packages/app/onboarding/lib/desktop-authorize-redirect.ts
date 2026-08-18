/**
 * Browser→desktop hand-off for the loopback authorization-code flow (FEA-2460 /
 * PLN-843 Amendment 1). After a successful mint the browser is navigated to the
 * desktop's loopback `redirect_uri` carrying the one-time `code` and the
 * round-tripped `state`.
 *
 * Unlike the poll-based custom-scheme return, carrying the code here is safe:
 * the `redirect_uri` is an IP-literal loopback (port-bound, non-hijackable) and
 * the code is inert without the desktop-held PKCE verifier and device key.
 */

/**
 * Build the loopback callback URL: the (already loopback-validated)
 * `redirect_uri` plus `code` and `state`. Pure and testable.
 */
export function buildLoopbackRedirectUrl(
  redirectUri: string,
  code: string,
  state: string
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * OAuth's `error` code for "the user said no". Sent to the loopback when the
 * consent screen is cancelled.
 */
export const DESKTOP_AUTHORIZE_ACCESS_DENIED = "access_denied";

/**
 * Build the loopback callback URL for a CANCELLED authorization.
 *
 * Cancelling used to be purely client-side: the page said "you can close this
 * tab" and never touched the loopback, so the desktop sat in its awaiting-redirect
 * state until the sign-in timeout eventually fired. Telling the listener is what
 * turns "nothing happens for a while" into an immediate, honest answer.
 *
 * Carries `state` for the same reason the success URL does — the desktop matches
 * it before believing the callback is its own. No `code`, which is precisely how
 * an older desktop build (one that never learned to read `error`) still resolves:
 * it fails its own code-present check and settles the run instead of waiting.
 */
export function buildLoopbackCancelUrl(
  redirectUri: string,
  state: string
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", DESKTOP_AUTHORIZE_ACCESS_DENIED);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Hand the browser off to the desktop loopback listener. Thin wrapper over
 * `location.replace` (no history entry) so component tests can mock the
 * navigation without touching jsdom's `location`.
 */
export function redirectToDesktopLoopback(url: string): void {
  globalThis.location.replace(url);
}
