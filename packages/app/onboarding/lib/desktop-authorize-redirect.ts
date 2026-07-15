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
 * Hand the browser off to the desktop loopback listener. Thin wrapper over
 * `location.replace` (no history entry) so component tests can mock the
 * navigation without touching jsdom's `location`.
 */
export function redirectToDesktopLoopback(url: string): void {
  globalThis.location.replace(url);
}
