import { authMiddleware } from "@repo/auth/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const TRAILING_SLASH_REGEX = /\/$/;

// Allowed origins for CORS - built from environment variables
function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>(["http://localhost:3000"]);

  // Add the configured app URL (works for staging, production, or preview)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    origins.add(appUrl);
    // Also add without trailing slash in case of mismatch
    origins.add(appUrl.replace(TRAILING_SLASH_REGEX, ""));
  }

  return origins;
}

const allowedOrigins = getAllowedOrigins();

function isOriginAllowed(origin: string | null): boolean {
  return !!origin && allowedOrigins.has(origin);
}

function getCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };

  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin"; // important with CDN caching
  }

  return headers;
}

function addCorsHeaders(response: NextResponse, origin: string | null) {
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export default authMiddleware((_auth, request: NextRequest) => {
  const origin = request.headers.get("origin");

  // Handle preflight OPTIONS requests
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: getCorsHeaders(origin),
    });
  }

  // For other requests, add CORS headers to the response
  const response = NextResponse.next();
  return addCorsHeaders(response, origin);
});

export const config = {
  matcher: [
    // Run middleware on all routes except Next.js internals
    "/((?!_next).*)",
  ],
};
