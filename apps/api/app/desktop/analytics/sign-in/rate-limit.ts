import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";

/**
 * Security decision 4c: a registration-only budget, separate from the shared
 * pre-auth limits. The register route spends it under one constant key, so it
 * is a GLOBAL ceiling per API instance, not a per-caller budget. The per-caller
 * bound is the flowId-keyed pre-auth budget the route spends afterwards.
 */
export const registrationLimiter = new FixedWindowRateLimiter({
  maxRequests: 30,
});
/** Security decision 4a: bound Clerk lookups by the session's user, before lookup. */
export const reportLimiter = new FixedWindowRateLimiter({ maxRequests: 30 });
