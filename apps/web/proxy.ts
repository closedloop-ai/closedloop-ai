import { authMiddleware } from "@repo/auth/proxy";
import { internationalizationMiddleware } from "@repo/internationalization/proxy";
import { noseconeOptions, securityMiddleware } from "@repo/security/proxy";
import type { NextMiddleware as NemoMiddleware } from "@rescale/nemo";
import { createNEMO } from "@rescale/nemo";
import type { NextMiddleware as AppMiddleware } from "next/server";
import { NextResponse } from "next/server";
import { env } from "./env";

// Clerk middleware wraps other middleware in its callback
const middleware: AppMiddleware = authMiddleware(
  async (_auth, request, event) => {
    const host = request.headers.get("host")?.split(":")[0] ?? "";

    // Redirect old closedloop.ai sitemap paths to gethealthy.com
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
    const securityHeaderResponse = await securityHeaders();

    // Then run composed middleware (i18n)
    const middlewareResponse = await composedMiddleware(request, event);

    // If i18n middleware returned a response, merge security headers onto it
    if (middlewareResponse) {
      applySecurityHeaders(middlewareResponse, securityHeaderResponse);
      return middlewareResponse;
    }

    return securityHeaderResponse;
  },
  {
    contentSecurityPolicy:
      env.CSP_ENABLED === "true"
        ? {
            strict: true,
            reportOnly: true,
            directives: {
              "base-uri": ["none"],
              "connect-src": [
                "https://*.posthog.com",
                "https://www.google-analytics.com/",
                "https://analytics.google.com/",
                // GA4's measurement protocol also beacons to
                // google.com/g/collect; allow it so report-only CSP does
                // not fire false-positive violations on every page.
                "https://www.google.com",
              ],
            },
            reportTo: env.CSP_REPORT_URI,
          }
        : undefined,
  }
);

export default middleware;

export const config = {
  // matcher tells Next.js which routes to run the middleware on. This runs the
  // middleware on all routes except for static assets and Posthog ingest.
  // The root-segment metadata files must be excluded too: i18n rewrites
  // unmatched paths into `[locale]`, where those routes do not exist, so every
  // one of them 404s. `robots.txt` and `sitemap.xml` are the same case —
  // `app/robots.ts` and `app/sitemap.ts` are root routes with no `[locale]`
  // counterpart — so they belong here beside the icons rather than waiting to
  // be noticed separately. `manifest.webmanifest` (`app/manifest.ts`) is the
  // same again, and it drags its two `public/` icons with it: a manifest that
  // resolves while its `src` entries rewrite into `[locale]` installs an app
  // with no icon, which fails quieter than a 404 on the manifest itself.
  //
  // The two groups are NOT interchangeable. The first are path PREFIXES with
  // real subtrees. The second are exact files, so each carries `$` and escapes
  // its dot: unanchored, `opengraph-image.png` also excludes
  // `/opengraph-image.png/docs`, which then reaches the dynamic `[locale]`
  // route with the security headers and Clerk context this middleware adds
  // skipped; unescaped, the dot is a wildcard and `/opengraph-imageXpng` is
  // excluded too.
  matcher: [
    "/((?!_next/static|_next/image|ingest|illustrations/|ib-claude-training|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|opengraph-image\\.png$|manifest\\.webmanifest$|web-app-manifest-192x192\\.png$|web-app-manifest-512x512\\.png$|robots\\.txt$|sitemap\\.xml$).*)",
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

// Workspace packages can resolve Next through different optional-peer hashes.
// Adapt the request-only i18n middleware to Nemo's lighter middleware shape.
const runInternationalizationMiddleware: NemoMiddleware = (request) =>
  internationalizationMiddleware(
    request as unknown as Parameters<typeof internationalizationMiddleware>[0]
  ) as unknown as ReturnType<NemoMiddleware>;

// Compose non-Clerk middleware with Nemo
const composedMiddleware = createNEMO(
  {},
  {
    before: [runInternationalizationMiddleware],
  }
);

function applySecurityHeaders(
  target: Response,
  securityHeadersResponse: Response
): void {
  securityHeadersResponse.headers.forEach((value, key) => {
    if (key.startsWith("x-middleware-")) {
      return;
    }

    target.headers.set(key, value);
  });
}
