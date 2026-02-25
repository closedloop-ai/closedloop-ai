import { authMiddleware } from "@repo/auth/proxy";
import {
  noseconeOptions,
  noseconeOptionsWithToolbar,
  securityMiddleware,
} from "@repo/security/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rewriteForLinkUnfurler } from "@/lib/link-unfurler";
import { env } from "./env";

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * Guards /api/engineer/* routes to localhost only.
 *
 * Engineer API routes spawn local CLI processes (Claude, git, codex) and
 * read/write the local filesystem. They must never be accessible in deployed
 * environments — EngineerGuard only blocks the UI, not the HTTP layer.
 *
 * See CLAUDE.md "Engineer Feature — Architectural Exception" for full context.
 */
function engineerGuard(request: NextRequest): NextResponse | null {
  if (!request.nextUrl.pathname.startsWith("/api/engineer/")) {
    return null;
  }
  const hostname = request.headers.get("host")?.split(":")[0] ?? "";
  if (!LOCALHOST_HOSTNAMES.has(hostname)) {
    return NextResponse.json(
      { error: "Engineer API is only available on localhost" },
      { status: 403 }
    );
  }
  return null;
}

const securityHeaders = env.FLAGS_SECRET
  ? securityMiddleware(noseconeOptionsWithToolbar)
  : securityMiddleware(noseconeOptions);

// Clerk middleware wraps other middleware in its callback
// For apps using Clerk, compose middleware inside authMiddleware callback
// For apps without Clerk, use createNEMO for composition (see apps/web)
export default authMiddleware((_auth, request) => {
  const guardResponse = engineerGuard(request);
  if (guardResponse) {
    return guardResponse;
  }

  const unfurlerResponse = rewriteForLinkUnfurler(request);
  if (unfurlerResponse) {
    return unfurlerResponse;
  }

  return securityHeaders();
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    // Do not use String.raw here! Next.js can't statically analyze String.raw, so this breaks the build.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
