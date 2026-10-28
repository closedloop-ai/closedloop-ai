// Mock for @clerk/nextjs/errors in tests.
//
// The bare `@clerk/nextjs` alias below it is a PREFIX alias, so without this
// entry `@clerk/nextjs/errors` rewrites to `<clerk-nextjs mock>/errors` and
// fails to resolve — which is a module-graph error, not a test failure, and
// takes the whole file down before a single case runs (ISS-11315).

/**
 * Clerk's own predicate for "the user dismissed the re-verification prompt".
 * The real one tags its error objects; tests construct the shape they need, so
 * this recognises the tag rather than the class.
 */
export const isReverificationCancelledError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "reverification_cancelled";
