import { analyticsMiddleware } from "@repo/analytics/proxy";
import { isReservedOrgSlug } from "@repo/api/src/types/reserved-slugs";
import { authMiddleware } from "@repo/auth/proxy";
import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import { noseconeOptions, securityMiddleware } from "@repo/security/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env } from "./env";
import { shouldEnableContentSecurityPolicy } from "./lib/content-security-policy";
import { getPossibleElectronHostnames } from "./lib/engineer/electron-probe";
// SECURITY CRITICAL: the localhost-only gateway guard. Enforced here, in the
// Clerk middleware chain, before any gateway request is allowed through. The
// implementation lives in a leaf module so the 403/401 decisions are unit-
// testable; do NOT bypass or remove this call (arbitrary command execution risk).
import { gatewayGuard } from "./lib/engineer/gateway-guard";

const ELECTRON_HOSTNAMES = getPossibleElectronHostnames().map(
  ({ hostname }) => hostname
);

// Clerk middleware wraps other middleware in its callback
export default authMiddleware(
  async (auth, request) => {
    const securityHeadersResponse = await securityHeaders();

    const redirectResponse = await orgSlugRedirect(auth, request);
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

const AUTHENTICATED_ROUTE_DIRECTORIES = new Set([
  "my-tasks",
  "inbox",
  "loops",
  "agents",
  "judges-analytics",
  "teams",
  "prds",
  "features",
  "implementation-plans",
  "build",
  "settings",
  "search",
  "users",
  "documents",
  "dashboard",
  "insights",
  "issues",
  "branches",
  "organization",
  "sessions",
  "webhooks",
]);

async function orgSlugRedirect(
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

  const firstSegment = pathname.split("/")[1];
  if (!firstSegment) {
    return null;
  }

  if (isReservedOrgSlug(firstSegment)) {
    return null;
  }

  if (!AUTHENTICATED_ROUTE_DIRECTORIES.has(firstSegment)) {
    return null;
  }

  const authState = await auth();
  const orgSlug = authState.orgSlug;
  if (!orgSlug) {
    return null;
  }

  if (firstSegment === orgSlug) {
    return null;
  }

  const url = request.nextUrl.clone();
  url.pathname = `/${orgSlug}${pathname}`;
  return NextResponse.redirect(url, 302);
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
