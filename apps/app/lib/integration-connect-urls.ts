import { GITHUB_CLERK_LINK_PATH } from "@repo/api/src/types/github-clerk-link";
import { GOOGLE_OAUTH_CONNECT_PATH } from "@repo/api/src/types/integration-connect-routes";

/**
 * Web-shell OAuth connect URLs.
 *
 * These return the app's Next API routes that *initiate* the browser OAuth
 * redirect flow (the browser navigates to them; they are not fetched through
 * the API client). They are surface-specific to the web shell — a desktop
 * renderer would drive OAuth through a different flow (system browser +
 * loopback/custom-scheme callback) — so they intentionally live in `apps/app`
 * rather than the surface-agnostic `@repo/app` layer (FEA-1510). The portable
 * integration *data* hooks remain in `@repo/app/<github|google>/hooks`.
 */

export function getGitHubConnectUrl(
  mode: "authorize" | "install" = "authorize",
  options: { returnTo?: string } = {}
): string {
  const params = new URLSearchParams();
  if (mode === "install") {
    params.set("install", "true");
  }
  if (options.returnTo) {
    params.set("returnTo", options.returnTo);
  }
  const query = params.toString();
  // PLN-1742 M5: authorize mode targets the Clerk linking page,
  // unconditionally — the in-house authorize route is retired (it redirects
  // stale clients here). Install mode stays on the app route:
  // `/apps/{slug}/installations/new` is the App-install entry point and
  // survives the OAuth-client retirement.
  const base =
    mode === "authorize" ? GITHUB_CLERK_LINK_PATH : "/api/integrations/github";
  if (query) {
    return `${base}?${query}`;
  }
  return base;
}

export function getGoogleOAuthUrl(): string {
  return GOOGLE_OAUTH_CONNECT_PATH;
}
