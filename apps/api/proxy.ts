import { authMiddleware } from "@repo/auth/proxy";

// Clerk middleware for API authentication
export default authMiddleware();

export const config = {
  matcher: [
    // Run middleware on all routes except Next.js internals
    "/((?!_next).*)",
  ],
};
