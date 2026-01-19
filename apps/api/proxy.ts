import { authMiddleware } from "@repo/auth/proxy";
import type { NextProxy } from "next/server";

// Clerk middleware for API authentication
export default authMiddleware() as unknown as NextProxy;

export const config = {
  matcher: [
    // Run middleware on all routes except Next.js internals
    "/((?!_next).*)",
  ],
};
