import { authMiddleware } from "@repo/auth/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isTrustedOrigin } from "@/lib/trusted-origins";

export default authMiddleware((_, request) => {
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  const response = NextResponse.next();
  const origin = request.headers.get("origin");
  return addCorsHeaders(response, origin);
});

export const config = {
  matcher: [
    // Run middleware on all routes except Next.js internals.
    // /internal/* routes are excluded because they use secret-based auth
    // validated directly in route handlers (not via Clerk session middleware).
    "/((?!_next|internal).*)",
  ],
};

function getCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };

  if (origin && isTrustedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin"; // important with CDN caching
  }

  return headers;
}

function addCorsHeaders(response: Response, origin: string | null) {
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

const handleOptions = (request: NextRequest) => {
  const origin = request.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
};
