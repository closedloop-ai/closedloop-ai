import { authMiddleware } from "@repo/auth/proxy";
import { internationalizationMiddleware } from "@repo/internationalization/proxy";
import { noseconeOptions, securityMiddleware } from "@repo/security/proxy";
import { createNEMO } from "@rescale/nemo";
import { NextResponse } from "next/server";

export const config = {
  // matcher tells Next.js which routes to run the middleware on. This runs the
  // middleware on all routes except for static assets and Posthog ingest
  matcher: ["/((?!_next/static|_next/image|ingest|favicon.ico).*)"],
};

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
  // Run security headers first
  const headersResponse = securityHeaders();

  // Then run composed middleware (i18n)
  const middlewareResponse = await composedMiddleware(request, event);

  // Return middleware response if it exists, otherwise headers response
  return middlewareResponse || headersResponse;
});
