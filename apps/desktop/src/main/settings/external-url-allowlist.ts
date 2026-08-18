// Allowlist for URLs the main process may hand to the OS via
// shell.openExternal. Centralized here so every caller (renderer-opened links in
// window.ts and IPC handlers that open stored URLs) enforces the same policy:
// https only, no embedded credentials, and a known host.
const EXTERNAL_LINK_HOSTS = new Set([
  "app.closedloop.ai",
  "closedloop.ai",
  "docs.closedloop.ai",
  "github.com",
]);

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      EXTERNAL_LINK_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * Whether a server-supplied first-party desktop sign-in verification URL
 * (FEA-2219) may be handed to the OS via `shell.openExternal`.
 *
 * Unlike {@link isAllowedExternalUrl} (a fixed prod-host allowlist for static
 * links), the sign-in origin is configurable — the desktop talks to whatever
 * `webAppOrigin` it is pointed at (prod, a stage/preview host, or a local dev
 * server). So the check is: the verification URL must live on the EXACT origin
 * the desktop itself sent to `/desktop/device-onboarding/start`. This preserves
 * the security property — a malicious or MITM'd `start` response cannot redirect
 * the browser to another host or a `file:`/custom-scheme target — while letting
 * localhost / stage / prod all work per configuration, never pinning testing to
 * production.
 *
 * `https` is required except for loopback hosts (local dev over `http`); the URL
 * must carry no embedded credentials.
 */
export function isAllowedDesktopVerificationUrl(
  url: string,
  webAppOrigin: string
): boolean {
  let parsed: URL;
  let trusted: URL;
  try {
    parsed = new URL(url);
    trusted = new URL(webAppOrigin);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  const schemeAllowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname));
  if (!schemeAllowed) {
    return false;
  }
  // Exact scheme+host+port match against the configured trusted origin. Also
  // guards the opaque-origin (`"null"`) case: a non-http(s) `webAppOrigin` can't
  // sneak a `file:` URL through, since the scheme check above already rejects it.
  return parsed.origin === trusted.origin;
}

/**
 * ISS-4898 (wongk + codex review): whether a renderer-opened URL may be handed
 * to the OS, given the web-app origin this desktop is CONFIGURED against.
 *
 * {@link isAllowedExternalUrl} alone is a fixed PRODUCTION host set. That is
 * correct for the static links (docs, GitHub), but the session-detail
 * linked-artifact pills build their href on the configured `webAppOrigin` — so
 * on any stage, preview, or localhost profile every one of those pills rendered
 * as a live anchor and every click was silently denied here. A control that
 * looks actionable and does nothing is the failure mode this row exists to fix.
 *
 * The fix is NOT to widen the fixed host set (that would let a compromised
 * renderer open any `*.closedloop-stage.ai` URL on a production install).
 * Instead the configured origin is admitted by the SAME fail-closed rule
 * {@link isAllowedDesktopVerificationUrl} already applies to the sign-in
 * verification URL: an EXACT scheme+host+port match against the origin this
 * desktop is pointed at, `https` except on loopback, and no embedded
 * credentials. A production-profile desktop therefore admits exactly the
 * production origin it already admitted, and nothing new.
 *
 * `webAppOrigin` is `null` when it could not be resolved; the fixed allowlist
 * still applies, so the docs/GitHub links keep working while artifact pills stay
 * denied — the same "unknown origin means no link" posture the renderer's
 * `useWebAppOrigin` takes.
 */
export function isAllowedRendererExternalUrl(
  url: string,
  webAppOrigin: string | null
): boolean {
  if (isAllowedExternalUrl(url)) {
    return true;
  }
  return webAppOrigin === null
    ? false
    : isAllowedDesktopVerificationUrl(url, webAppOrigin);
}
