import { analyticsMiddleware } from "@repo/analytics/proxy";
import { authMiddleware } from "@repo/auth/proxy";
import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import { noseconeOptions, securityMiddleware } from "@repo/security/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env } from "./env";
import {
  RedirectStatus,
  requiresOrgSlugResolution,
  resolveRedirect,
  resolveRedirectSearchParams,
  shouldRewriteLegacyIssueUnfurl,
} from "./lib/app-route-redirects";
import { shouldEnableContentSecurityPolicy } from "./lib/content-security-policy";
import { getPossibleElectronHostnames } from "./lib/engineer/electron-probe";
// SECURITY CRITICAL: the localhost-only gateway guard. Enforced here, in the
// Clerk middleware chain, before any gateway request is allowed through. The
// implementation lives in a leaf module so the 403/401 decisions are unit-
// testable; do NOT bypass or remove this call (arbitrary command execution risk).
import { gatewayGuard } from "./lib/engineer/gateway-guard";
import {
  buildGitHubConnectRedirectUrl,
  shouldDeepLinkGitHubConnect,
} from "./lib/github-connect-redirect";

const ELECTRON_HOSTNAMES = getPossibleElectronHostnames().map(
  ({ hostname }) => hostname
);

// Clerk middleware wraps other middleware in its callback
export default authMiddleware(
  async (auth, request) => {
    const securityHeadersResponse = await securityHeaders();

    const redirectResponse = await routeRedirect(auth, request);
    if (redirectResponse) {
      applySecurityHeaders(redirectResponse, securityHeadersResponse);
      return redirectResponse;
    }

    const guardResponse = await gatewayGuard(auth, request);
    if (guardResponse) {
      applySecurityHeaders(guardResponse, securityHeadersResponse);
      return guardResponse;
    }

    const response = NextResponse.next();
    const analyticsResponse = await analyticsMiddleware(response)(request);
    applySecurityHeaders(analyticsResponse, securityHeadersResponse);
    return analyticsResponse;
  },
  {
    contentSecurityPolicy: shouldEnableContentSecurityPolicy(
      env.CSP_ENABLED,
      env.VERCEL_ENV
    )
      ? {
          // FEA-4149: this report-only strict CSP surfaces `unsafe-eval`
          // violations in prod/stage. The offender is not yet confirmed. A
          // `Function("return this")()` globalThis-polyfill fallback (codegen,
          // hence an `unsafe-eval` violation) exists in `posthog-js`'s
          // `dist/array.full.es5.js`, but that is NOT the entry our bundle
          // loads: `@posthog/next` imports `posthog-js` through its
          // `module`/`main` entry (`dist/module.js` / `dist/main.js`), and
          // those resolve the global with `globalThis`, not `Function(...)`.
          // So while PostHog is a plausible suspect, the imported code path
          // does not prove it; the report-to endpoint (below) is what will
          // actually attribute the violation once reports arrive. Confirming
          // the offender and remediating it is deferred as a follow-up.
          // Deliberately NOT adding `unsafe-eval` here: it would re-open
          // string-to-code execution for the entire script-src and defeat the
          // point of the strict policy. A `script-src` hash cannot authorize
          // this either — hashes match static script resources/inline bodies,
          // whereas `eval`/`Function` codegen is gated by `unsafe-eval`
          // specifically. The real fixes are removing/upgrading or isolating
          // whatever dependency does the codegen. Report-only means this is
          // observed, not enforced, so nothing is broken meanwhile.
          strict: true,
          reportOnly: true,
          directives: {
            "base-uri": ["none"],
            "connect-src": [
              env.NEXT_PUBLIC_API_URL!,
              "https://api.liveblocks.io",
              "wss://api.liveblocks.io",
              "https://browser-intake-datadoghq.com",
              "https://*.browser-intake-datadoghq.com",
              "https://*.posthog.com",
              // Include Google Analytics only when the measurement ID is
              // configured. Without it, browser extension injections and
              // speculative GA requests generate false-positive CSP
              // violation reports in report-only mode.
              ...(env.NEXT_PUBLIC_GA_MEASUREMENT_ID
                ? [
                    "https://www.google-analytics.com/",
                    // GA4's measurement protocol also beacons to
                    // google.com/g/collect; allow it so report-only CSP
                    // does not fire false-positive violations on every page.
                    "https://www.google.com",
                  ]
                : []),
              ...ELECTRON_HOSTNAMES,
            ],
            "img-src": ["data:"],
          },
          reportTo: env.CSP_REPORT_URI,
        }
      : undefined,
  }
);

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    // Do not use String.raw here! Next.js can't statically analyze String.raw, so this breaks the build.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};

/**
 * Resolve every path-level redirect this app owns in ONE pass, so a request
 * that needs both the FEA-4137 `/features` → `/issues` rename and the org-slug
 * prefix costs a single round trip instead of one per rewrite.
 *
 * `auth()` stays lazy: it is only awaited once the pathname is known to name an
 * org-scoped route directory.
 */
async function routeRedirect(
  auth: ClerkMiddlewareAuth,
  request: NextRequest
): Promise<NextResponse | null> {
  const pathname = request.nextUrl.pathname;

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/trpc/") ||
    pathname.startsWith("/_next/")
  ) {
    return null;
  }

  // Two INDEPENDENT reasons this request may need the auth state. They are
  // evaluated separately so neither silently depends on the other's route
  // table: the connect deep link sits under `/settings/...`, which
  // `requiresOrgSlugResolution` also matches today, but nesting the check
  // inside that branch would make the flow's reachability an accident of
  // `AUTHENTICATED_ROUTE_DIRECTORIES` — dropping `settings` from that list
  // would disable the deep link with no compile-time or test signal.
  const needsOrgSlug = requiresOrgSlugResolution(pathname);
  const needsConnectDeepLink = shouldDeepLinkGitHubConnect(pathname);

  // Lazy auth: only pathnames that actually depend on it pay for it, and the
  // two reasons share ONE await rather than resolving auth twice.
  let orgSlug: string | null = null;
  if (needsOrgSlug || needsConnectDeepLink) {
    const authState = await auth();
    orgSlug = needsOrgSlug ? (authState.orgSlug ?? null) : null;

    // A SIGNED-OUT desktop authorize request goes to the GitHub-first connect
    // entry instead of the generic sign-in embed (PRD-562). The click that
    // opened this URL said "Connect to GitHub", so the page it lands on is
    // GitHub's own authorize screen rather than a provider chooser.
    //
    // Decided here rather than in the desktop build because installed desktop
    // versions are skewed: keying off the URL they already open means every
    // shipped build gets this flow without a desktop release.
    if (needsConnectDeepLink && !authState.userId) {
      // Temporary by nature: this fires only while the caller is signed OUT, so
      // the same URL must reach the app itself once they are not.
      return NextResponse.redirect(
        buildGitHubConnectRedirectUrl(request.nextUrl),
        RedirectStatus.Temporary
      );
    }
  }

  if (
    shouldRewriteLegacyIssueUnfurl(
      pathname,
      orgSlug,
      request.headers.get("user-agent")
    )
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("redirect_url", request.nextUrl.toString());
    return NextResponse.rewrite(url);
  }

  const redirect = resolveRedirect(
    pathname,
    orgSlug,
    request.nextUrl.searchParams
  );
  if (!redirect) {
    return null;
  }

  // Clone (rather than build) the incoming URL so the query string — the
  // `?version=3` deep links the legacy-route compat window exists to preserve —
  // survives the redirect untouched.
  const url = request.nextUrl.clone();
  url.pathname = redirect.pathname;

  // ISS-5011: a retired route whose successor is one tab of a larger surface is
  // not reached by pathname alone, so overlay the query that selects it.
  //
  // `remove` runs first: the destination gives some keys precedence over the one
  // the forward sets, so leaving them on the clone silently beats the forward.
  // `/organization?github=bogus` is the case — Settings treats any nonempty
  // `github`/`google`/`linear` as an OAuth callback and forces Integrations,
  // landing the user on a tab their URL does not name (wongk, PR #4501).
  //
  // Then `set` (not append), so the forward's own tab wins over a stale one on
  // the incoming bookmark. Every unrelated key the clone carried — the
  // `?version=3` deep links this compat window exists for — is left untouched.
  const redirectSearchParams = resolveRedirectSearchParams(pathname, orgSlug);
  if (redirectSearchParams) {
    for (const key of redirectSearchParams.remove) {
      url.searchParams.delete(key);
    }
    for (const [key, value] of Object.entries(redirectSearchParams.set)) {
      url.searchParams.set(key, value);
    }
  }

  // ISS-4570: the status comes from the resolver, which is the only thing that
  // knows whether this redirect's target depends on the caller. A flat status
  // here made the FEA-3955 `/features` → `/issues` rename temporary against its
  // own spec; hardcoding the permanent one instead would cache a user-specific
  // org prefix in every browser that follows it.
  return NextResponse.redirect(url, redirect.status);
}

const securityHeaders = securityMiddleware(noseconeOptions);

function applySecurityHeaders(
  target: NextResponse,
  securityHeadersResponse: Response
): void {
  securityHeadersResponse.headers.forEach((value, key) => {
    if (key.startsWith("x-middleware-")) {
      return;
    }

    target.headers.set(key, value);
  });
}
