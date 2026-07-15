/**
 * Loopback redirect-URI allowlist for the desktop OAuth authorization-code flow
 * (FEA-2409 / PLN-843 Amendment 1). The desktop starts an ephemeral loopback
 * HTTP server and passes its `http://127.0.0.1:<port>/…` (or `[::1]`) redirect
 * URI to the authorize endpoint; the browser is then redirected there with the
 * one-time authorization code.
 *
 * Policy (RFC 8252 §7.3, "OAuth for Native Apps"):
 * - IP-literal loopback hosts only (`127.0.0.1` / `[::1]`) — NOT `localhost`,
 *   which can be repointed via DNS or the hosts file to a non-loopback address.
 * - Any port (the desktop binds an ephemeral one).
 * - `http` only — loopback traffic never leaves the host, so TLS is neither
 *   available nor required; a non-loopback host over `http` is always rejected.
 * - No embedded credentials.
 *
 * Rejecting a foreign/crafted redirect URI stops a stolen or attacker-supplied
 * URI from exfiltrating the code to another host. The flow's security
 * additionally rests on PKCE + device PoP, which make a leaked code inert.
 *
 * Custom-scheme redirects (e.g. `closedloop://`) are intentionally NOT accepted
 * here: they are hijackable by another local app registering the same scheme.
 * If added later they are a non-secret convenience only, gated separately.
 */

/**
 * WHATWG `URL.hostname` renders an IPv6 literal with brackets (`[::1]`); the
 * bracket-free form is included for defensiveness across runtimes.
 */
const LOOPBACK_REDIRECT_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "::1",
]);

export function isAllowedDesktopLoopbackRedirectUri(uri: string): boolean {
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
