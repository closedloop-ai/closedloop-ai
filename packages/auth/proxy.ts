// biome-ignore lint/performance/noBarrelFile: re-exporting Clerk auth middleware
export { clerkMiddleware as authMiddleware } from "@clerk/nextjs/server";
