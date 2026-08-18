// biome-ignore-all lint/performance/noBarrelFile: intentional re-export for package API
import "server-only";
import {
  auth as clerkAuth,
  currentUser as clerkCurrentUser,
} from "@clerk/nextjs/server";
import { isLocalTrustedAuthActive } from "./auth-mode";
import {
  buildLocalTrustedAuth,
  buildLocalTrustedUser,
} from "./local-trusted-session";

export * from "@clerk/nextjs/server";

/**
 * FEA-4334: `auth()` with the `AUTH_MODE=local_trusted` render path (see
 * `auth-mode.ts`). In the default `clerk` mode this delegates verbatim to
 * Clerk's `auth()` — including its `auth.protect()` surface, preserved by
 * `Object.assign` below — so the real path is behaviorally unchanged.
 * `isLocalTrustedAuthActive()` throws if `local_trusted` is configured in
 * production/stage/preview, so a misconfigured deploy fails closed instead of
 * serving a synthetic session.
 *
 * These explicit `const` bindings shadow the same names pulled in by the
 * `export *` above (a local declaration wins over a wildcard re-export), so
 * every consumer of `@repo/auth/server` gets the wrapped versions.
 */
const wrappedAuth = (...args: Parameters<typeof clerkAuth>) => {
  if (isLocalTrustedAuthActive()) {
    return Promise.resolve(buildLocalTrustedAuth());
  }
  return clerkAuth(...args);
};

// Preserve `auth.protect()` (and any other properties Clerk hangs off `auth`)
// so the wrapper is a drop-in for the real `AuthFn`. The synthetic path never
// exposes `protect`; it is only reachable in `clerk` mode, where it is the real
// Clerk implementation.
export const auth: typeof clerkAuth = Object.assign(wrappedAuth, clerkAuth);

export const currentUser: typeof clerkCurrentUser = (...args) => {
  if (isLocalTrustedAuthActive()) {
    return Promise.resolve(buildLocalTrustedUser());
  }
  return clerkCurrentUser(...args);
};
