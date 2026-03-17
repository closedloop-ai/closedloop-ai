import { analyticsMiddleware } from "@repo/analytics/proxy";
import { authMiddleware } from "@repo/auth/proxy";
import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import {
  noseconeOptions,
  noseconeOptionsWithToolbar,
  securityMiddleware,
} from "@repo/security/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env } from "./env";
import { resolveApiOrigin } from "./lib/api-origin";

// Clerk middleware wraps other middleware in its callback
export default authMiddleware(async (auth, request) => {
  const securityHeadersResponse = await securityHeaders();

  const guardResponse = await engineerGuard(auth, request);
  if (guardResponse) {
    applySecurityHeaders(guardResponse, securityHeadersResponse);
    return guardResponse;
  }

  const response = NextResponse.next();
  const analyticsResponse = await analyticsMiddleware(response)(request);
  applySecurityHeaders(analyticsResponse, securityHeadersResponse);

  return analyticsResponse;
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

/**
 * Guards engineer API routes to localhost or authenticated users with
 * registered compute targets (cached for 30s).
 *
 * Engineer API routes spawn local CLI processes (Claude, git, codex) and
 * read/write the local filesystem. They must never be accessible in deployed
 * environments — EngineerGuard only blocks the UI, not the HTTP layer.
 *
 * See CLAUDE.md "Engineer Feature — Architectural Exception" for full context.
 */
async function engineerGuard(
  auth: ClerkMiddlewareAuth,
  request: NextRequest
): Promise<NextResponse | null> {
  const pathname = request.nextUrl.pathname;
  const isLocal = isEngineerLocalPath(pathname);
  const isRelay = isEngineerRelayPath(pathname);

  if (!(isLocal || isRelay)) {
    return null;
  }

  const hostname = request.headers.get("host")?.split(":")[0] ?? "";
  if (LOCALHOST_HOSTNAMES.has(hostname)) {
    return null;
  }

  // /api/engineer/* routes spawn local CLI processes — always localhost-only.
  if (isLocal) {
    return NextResponse.json(
      { error: "Engineer API is only available on localhost" },
      { status: 403 }
    );
  }

  // /api/engineer-relay/* routes are cloud-safe but require a compute target.
  const authState = await auth();
  if (!authState.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = await authState.getToken();
  const hasComputeTarget =
    typeof token === "string" && token.length > 0
      ? await fetchHasComputeTarget(request, token).catch(() => false)
      : false;

  if (hasComputeTarget) {
    return null;
  }

  return NextResponse.json(
    { error: "Engineer API requires a registered compute target" },
    { status: 403 }
  );
}

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function isEngineerLocalPath(pathname: string): boolean {
  return pathname.startsWith("/api/engineer/");
}

function isEngineerRelayPath(pathname: string): boolean {
  return pathname.startsWith("/api/engineer-relay/");
}

async function fetchHasComputeTarget(
  request: NextRequest,
  token: string
): Promise<boolean> {
  const response = await fetch(`${resolveApiOrigin(request)}/compute-targets`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json().catch(() => null)) as {
    success: true;
    data: unknown;
  } | null;

  return Boolean(
    payload?.success && Array.isArray(payload.data) && payload.data.length > 0
  );
}

const securityHeaders = env.FLAGS_SECRET
  ? securityMiddleware(noseconeOptionsWithToolbar)
  : securityMiddleware(noseconeOptions);

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
