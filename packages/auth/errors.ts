/**
 * Clerk's client-side error predicates.
 *
 * Its own entry point because the SDK ships them on the `@clerk/nextjs/errors`
 * SUBPATH rather than the root, so `client.ts`'s star export does not reach
 * them — and app code must keep importing Clerk through `@repo/auth` rather
 * than growing direct `@clerk/nextjs` imports outside this package.
 */
// biome-ignore lint/performance/noBarrelFile: re-exporting Clerk error predicates
export { isReverificationCancelledError } from "@clerk/nextjs/errors";
