import { type Page, test } from "@playwright/test";
import {
  LOCAL_TRUSTED_DEFAULT_ORG_ID,
  LOCAL_TRUSTED_DEFAULT_USER_ID,
} from "@repo/api/src/types/local-trusted-auth";
import { isClerkFreeProject } from "../playwright-projects";

/**
 * ISS-10335: the suite-side half of the Clerk-free lane.
 *
 * `isClerkFreeRun` is the ONE place the running project's name is turned into
 * "this test has no Clerk session", so the API-origin resolver, the bearer
 * helper, the shell-entry waits and the per-test Clerk fixtures all branch on
 * the same answer.
 */

/**
 * Every Clerk host the browser can reach: the per-instance dev/prod FAPI, and
 * the backend API. Matched on the whole URL, so a path on any other host cannot
 * collide with it.
 */
const CLERK_HOST_PATTERN =
  /^https:\/\/(?:[^/]+\.clerk\.accounts\.dev|[^/]+\.clerk\.com|clerk\.[^/]+)\//;

/**
 * The Clerk traffic a Clerk-free lane must never produce, as opposed to the
 * traffic the SDK emits merely by being mounted.
 *
 * SCOPE, stated plainly because it is narrower than "no Clerk traffic":
 * the session-independent bootstrap (`/v1/environment`, `/v1/client`,
 * `/v1/dev_browser`) is NOT a finding. Since ISS-12054 `apps/app` mounts no
 * `ClerkProvider` under `AUTH_MODE=local_trusted` (`app/layout.tsx`), so this
 * lane should emit none of it, but the guard stays scoped to session traffic. What is a finding is a request that only a real session can serve or
 * that only a sign-in can produce: minting or refreshing a session token, and
 * the sign-in / sign-up flows. Those are exactly what comes back if someone
 * re-adds `storageState` and a `setup` dependency to this project, or calls the
 * real `getClerkBearerToken` from a spec here.
 */
const CLERK_SESSION_TRAFFIC_PATTERN =
  /\/v1\/(?:client\/(?:sessions|sign_ins|sign_ups)\b|me\/tokens\b)/;

/**
 * The annotation-free failure a Clerk-free test gets when it reached for a Clerk
 * session. Exported so the guard and the reader of a CI report read the same
 * sentence.
 */
export const CLERK_SESSION_TRAFFIC_FAILURE =
  "This project runs Clerk-free, but the browser requested a Clerk session endpoint";

/**
 * True when the CURRENTLY RUNNING test belongs to a Clerk-free project.
 *
 * `test.info()` throws outside a running test, and several helpers here are also
 * imported by module-scope code (a `test.skip` precondition, a config read), so
 * the throw is caught and reported as "not Clerk-free" — the pre-ISS-10335
 * behaviour, which is the safe direction: it keeps the live-Clerk path rather
 * than silently re-pointing a caller at an API that may not be running.
 */
export function isClerkFreeRun(): boolean {
  try {
    return isClerkFreeProject(test.info().project.name);
  } catch {
    return false;
  }
}

/**
 * True when `url` is a Clerk request that a lane with no Clerk session must
 * never make. See {@link CLERK_SESSION_TRAFFIC_PATTERN} for what is deliberately
 * NOT in this set.
 */
export function isClerkSessionTraffic(url: string): boolean {
  return (
    CLERK_HOST_PATTERN.test(url) && CLERK_SESSION_TRAFFIC_PATTERN.test(url)
  );
}

/**
 * Watch a Clerk-free page for session traffic, aborting it and collecting what
 * was seen.
 *
 * Aborts rather than observes: the request is refused, so the lane cannot
 * quietly start DEPENDING on a live Clerk session while the failure is still
 * being reported. Returns the collector the caller asserts on at teardown —
 * failing inside a route handler would be swallowed by Playwright, which is the
 * "assertion buried in a mock" shape root `AGENTS.md` rejects.
 */
export async function installClerkSessionTrafficGuard(
  page: Page
): Promise<() => readonly string[]> {
  const seen: string[] = [];

  await page.context().route(
    (url) => isClerkSessionTraffic(url.toString()),
    async (route) => {
      seen.push(route.request().url());
      await route.abort().catch(() => undefined);
    }
  );

  return () => seen;
}

/**
 * The user/org a persisted view-state key is scoped by — what
 * `useOptionalAuthSnapshot()` reports to the running app, resolved from the
 * suite side.
 *
 * `orgId` is nullable because a live-Clerk session can be signed in with no
 * active organization; a caller that needs one says so itself.
 */
export type ViewScopeIdentity = {
  readonly orgId: string | null;
  readonly userId: string;
};

/**
 * Resolve the identity the app scopes its saved-view `localStorage` keys by.
 *
 * ISS-10335: a spec that read this from `window.Clerk` hangs on the Clerk-free
 * lane, where nothing ever signs in. There the app's auth adapter is the STATIC
 * one (`createStaticAuthAdapter` in `apps/app/lib/app-core-adapters.tsx`), fed
 * the server-guarded synthetic identity — so the ids to key by are the ones the
 * compose file handed the app image, not anything the browser holds.
 *
 * `clerkFree` is injectable for the same reason `getClerkBearerToken`'s is: it
 * makes both branches reachable from a test outside a Clerk-free project. No
 * production caller passes it.
 */
export async function resolveViewScopeIdentity(
  page: Page,
  clerkFree: () => boolean = isClerkFreeRun
): Promise<ViewScopeIdentity> {
  if (clerkFree()) {
    return localTrustedViewScopeIdentity();
  }

  const handle = await page.waitForFunction(
    () => {
      const clerk = (
        globalThis as typeof globalThis & {
          Clerk?: {
            organization?: { id?: string | null } | null;
            user?: { id?: string | null } | null;
          };
        }
      ).Clerk;
      const userId = clerk?.user?.id ?? null;
      return userId ? { orgId: clerk?.organization?.id ?? null, userId } : null;
    },
    undefined,
    { timeout: CLERK_IDENTITY_TIMEOUT_MS }
  );
  const identity = await handle.jsonValue();
  if (!identity) {
    throw new Error("Web e2e Clerk fixture must expose a signed-in user.");
  }
  return identity;
}

/** How long a live-Clerk page gets to hydrate a signed-in user. */
const CLERK_IDENTITY_TIMEOUT_MS = 30_000;

/**
 * The synthetic session's ids, read from the runner's own environment.
 *
 * `e2e/compose.yml` forwards this same pair to `api-local` and `app-visual` as
 * `E2E_LOCAL_TRUSTED_ORG_ID` / `_USER_ID`, and both names are accepted here so a
 * host Playwright run against a hand-booted local_trusted app can set either.
 * Unset, the session takes the fixed defaults, which is the state on `main`.
 *
 * Those defaults come from `@repo/api` and not from their producer,
 * `packages/auth/auth-mode.ts`: that package is CommonJS, so importing it here
 * makes `playwright --list` fail to load every spec in this closure. The same
 * constraint, approach and trip-wire as `LOCAL_TRUSTED_CLIENT_TOKEN` beside them
 * (ISS-10335).
 */
function localTrustedViewScopeIdentity(): ViewScopeIdentity {
  return {
    orgId:
      process.env.E2E_LOCAL_TRUSTED_ORG_ID?.trim() ||
      process.env.SEED_SANDBOX_CLERK_ORG_ID?.trim() ||
      LOCAL_TRUSTED_DEFAULT_ORG_ID,
    userId:
      process.env.E2E_LOCAL_TRUSTED_USER_ID?.trim() ||
      process.env.SEED_SANDBOX_CLERK_USER_ID?.trim() ||
      LOCAL_TRUSTED_DEFAULT_USER_ID,
  };
}
