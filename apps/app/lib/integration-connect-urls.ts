/**
 * Web-shell OAuth connect URLs.
 *
 * These return the app's Next API routes that *initiate* the browser OAuth
 * redirect flow (the browser navigates to them; they are not fetched through
 * the API client). They are surface-specific to the web shell — a desktop
 * renderer would drive OAuth through a different flow (system browser +
 * loopback/custom-scheme callback) — so they intentionally live in `apps/app`
 * rather than the surface-agnostic `@repo/app` layer (FEA-1510). The portable
 * integration *data* hooks remain in `@repo/app/<github|google|linear>/hooks`.
 */

export function getGitHubConnectUrl(
  mode: "authorize" | "install" = "authorize"
): string {
  if (mode === "install") {
    return "/api/integrations/github?install=true";
  }
  return "/api/integrations/github";
}

export function getGoogleOAuthUrl(): string {
  return "/api/integrations/google";
}

export function getLinearOAuthUrl(): string {
  return "/api/integrations/linear";
}
