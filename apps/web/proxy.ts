import { authMiddleware } from "@repo/auth/proxy";
import { internationalizationMiddleware } from "@repo/internationalization/proxy";
import { noseconeOptions, securityMiddleware } from "@repo/security/proxy";
import { createNEMO } from "@rescale/nemo";
import { NextResponse } from "next/server";

export const config = {
  // matcher tells Next.js which routes to run the middleware on. This runs the
  // middleware on all routes except for static assets and Posthog ingest
  matcher: [
    "/((?!_next/static|_next/image|ingest|favicon.ico|illustrations/).*)",
  ],
};

// --- closedloop.ai → gethealthy.com 302 redirect config ---

const REDIRECT_HOST = "www.gethealthy.com";

const OLD_SITE_PREFIXES = [
  "/blog/",
  "/news/",
  "/press-release/",
  "/event/",
  "/downloadable-resources/",
  "/predict-use-cases/",
  "/career-listings/",
  "/career-type/",
  "/leadership-team/",
];

const OLD_SITE_PAGES = new Set([
  "/",
  "/cms-challenge",
  "/security-and-compliance",
  "/blog",
  "/healthcare-content-library",
  "/predict-use-cases",
  "/technical-team",
  "/predict-payers",
  "/payers",
  "/closedloop-platform",
  "/business-team",
  "/predict-digital-health",
  "/predict-pharma",
  "/predict-providers",
  "/evaluate",
  "/providers-and-acos",
  "/terms-of-use-enterprise",
  "/downloadable-resources",
  "/aco-predict",
  "/privacy-policy",
  "/events",
  "/closer-culture",
  "/awards-recognition",
  "/request-a-demo",
  "/contact-us",
  "/aco-predict-more-info",
  "/aco-predict-activate",
  "/news",
  "/leadership-team",
  "/careers",
]);

const TRAILING_SLASHES = /\/+$/;

function isOldSitePath(pathname: string): boolean {
  const normalized = pathname.replace(TRAILING_SLASHES, "") || "/";

  if (OLD_SITE_PAGES.has(normalized)) {
    return true;
  }

  return OLD_SITE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// --- end redirect config ---

const securityHeaders = securityMiddleware(noseconeOptions);

// Compose non-Clerk middleware with Nemo
const composedMiddleware = createNEMO(
  {},
  {
    before: [internationalizationMiddleware],
  }
);

// Clerk middleware wraps other middleware in its callback
export default authMiddleware(async (_auth, request, event) => {
  // Redirect old closedloop.ai sitemap paths to gethealthy.com
  const host = request.headers.get("host")?.split(":")[0] ?? "";

  if (host === "www.closedloop.ai" || host === "closedloop.ai") {
    const { pathname } = request.nextUrl;

    if (isOldSitePath(pathname)) {
      const url = new URL(request.url);
      url.hostname = REDIRECT_HOST;
      url.port = "";

      return NextResponse.redirect(url.toString(), 302);
    }
  }

  // Run security headers first
  const headersResponse = securityHeaders();

  // Then run composed middleware (i18n)
  const middlewareResponse = await composedMiddleware(request, event);

  // Return middleware response if it exists, otherwise headers response
  return middlewareResponse || headersResponse;
});
