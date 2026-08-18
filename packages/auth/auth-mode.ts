/**
 * FEA-4334 (FEA-4121 Slice 2): server-side Clerk-independent auth path.
 *
 * The authenticated web surfaces (`apps/app/app/(authenticated)/…`) are gated
 * server-side: the layout calls `auth()` + `currentUser()` from
 * `@repo/auth/server` and redirects when there is no active user. That gate
 * hydrates from a live Clerk session, so the e2e visual-regression container
 * cannot render those surfaces without signing in against a real Clerk
 * instance. `AUTH_MODE=local_trusted` swaps the Clerk session gate for a fixed,
 * obviously-synthetic identity so the container can render the branches/sessions
 * shells and mint Linux baselines — WITHOUT any real user or live Clerk call.
 *
 * SECURITY (this module is the whole security boundary of the feature):
 *   - `local_trusted` is refused unless BOTH conditions hold:
 *       (a) `AUTH_MODE === "local_trusted"`, AND
 *       (b) a hard non-production signal is present — `NODE_ENV !== "production"`
 *           AND `E2E_LOCAL_TRUSTED_AUTH === "1"` AND the deploy signal
 *           (`VERCEL_ENV`) is neither `production` nor `preview`.
 *   - If `AUTH_MODE === "local_trusted"` but the environment looks like
 *     production/stage/preview, this NEVER silently grants a synthetic session:
 *     it throws. A missing/other `AUTH_MODE` resolves to `clerk` (the default),
 *     leaving the real Clerk path 100% unchanged.
 *
 * The synthetic identity is fixed and obviously fake (see IDs below); it is
 * never a real user or org.
 */

/**
 * Server-side authentication modes. SSOT for the `AUTH_MODE` values — imported
 * by `keys.ts` (env validation) and the server auth wrappers so the literal
 * `"local_trusted"` is never re-typed at a call site.
 */
export const AuthMode = {
  /** Default: real Clerk sessions. Unchanged behavior. */
  Clerk: "clerk",
  /**
   * Non-production-only synthetic session for e2e/visual-regression. Guarded by
   * {@link isLocalTrustedAuthActive}; impossible to activate in production.
   */
  LocalTrusted: "local_trusted",
} as const;

export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode];

/**
 * Explicit env signal a test harness must set (alongside `AUTH_MODE`) to opt
 * into the synthetic session. A second, independent lock on top of `AUTH_MODE`
 * so a stray `AUTH_MODE=local_trusted` alone can never grant access.
 */
export const E2E_LOCAL_TRUSTED_AUTH_ENV = "E2E_LOCAL_TRUSTED_AUTH";
const E2E_LOCAL_TRUSTED_AUTH_ENABLED = "1";

/**
 * Vercel deploy environments where `local_trusted` must NEVER activate, even if
 * every other signal is (mis)set. `preview` is included: preview deployments are
 * internet-reachable and must stay Clerk-gated.
 */
const FORBIDDEN_VERCEL_ENVS = new Set(["production", "preview"]);

/** Fixed, obviously-synthetic identity. Never a real user/org. */
export const LOCAL_TRUSTED_USER_ID = "user_e2e_local_trusted";
export const LOCAL_TRUSTED_ORG_ID = "org_e2e_local_trusted";
export const LOCAL_TRUSTED_ORG_SLUG = "closedloop-ai";
export const LOCAL_TRUSTED_SESSION_ID = "sess_e2e_local_trusted";
export const LOCAL_TRUSTED_ORG_ROLE = "org:admin";
export const LOCAL_TRUSTED_USER_EMAIL = "e2e-local-trusted@example.test";

/**
 * True only when `AUTH_MODE=local_trusted` AND the hard non-production guard
 * passes. Reads `process.env` live (never memoized) so a test can flip the env
 * per-case. Any production/stage/preview signal forces `false` here and a throw
 * at the call boundary — the synthetic session is never granted silently.
 */
export function isLocalTrustedAuthConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.AUTH_MODE === AuthMode.LocalTrusted;
}

/**
 * The non-production signal that must hold for `local_trusted` to be allowed.
 * Kept separate from {@link isLocalTrustedAuthConfigured} so the call boundary
 * can distinguish "configured but forbidden here" (→ throw) from "not
 * configured" (→ Clerk).
 */
export function isNonProductionEnvironment(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.NODE_ENV === "production") {
    return false;
  }
  if (env[E2E_LOCAL_TRUSTED_AUTH_ENV] !== E2E_LOCAL_TRUSTED_AUTH_ENABLED) {
    return false;
  }
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv && FORBIDDEN_VERCEL_ENVS.has(vercelEnv)) {
    return false;
  }
  return true;
}

/**
 * Resolve whether the synthetic session should be served for this request.
 *
 * - Not configured (`AUTH_MODE` unset/`clerk`) → `false`, use Clerk (default).
 * - Configured AND non-production signal present → `true`, serve synthetic.
 * - Configured BUT production/stage/preview → THROWS. Never silently grants and
 *   never silently downgrades to Clerk while advertising `local_trusted`; the
 *   misconfiguration is loud, so a prod deploy with `AUTH_MODE=local_trusted`
 *   fails closed instead of exposing authed pages to anonymous traffic.
 */
export function isLocalTrustedAuthActive(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isLocalTrustedAuthConfigured(env)) {
    return false;
  }
  if (!isNonProductionEnvironment(env)) {
    throw new Error(
      "AUTH_MODE=local_trusted refused: it is only permitted outside production " +
        "with E2E_LOCAL_TRUSTED_AUTH=1 and VERCEL_ENV not production/preview. " +
        "Unset AUTH_MODE (defaults to clerk) for real deployments."
    );
  }
  return true;
}
