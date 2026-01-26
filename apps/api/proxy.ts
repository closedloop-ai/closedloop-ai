import { authMiddleware } from "@repo/auth/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Allowed origins for CORS
// TODO: migrate this to environment variables.
const allowedOrigins = new Set([
  "http://localhost:3000",
  "https://symphony-alpha-app-stage.vercel.app",
]);

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
