import { authMiddleware } from "@repo/auth/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { addCorsHeaders, getCorsHeaders } from "@/lib/cors";

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

const handleOptions = (request: NextRequest) => {
  const origin = request.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
};
