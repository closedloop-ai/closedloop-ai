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
 *           (`VERCEL_ENV`) is neither `production` nor `preview`. Since
 *           ISS-12054 also `NEXT_PUBLIC_APP_ENVIRONMENT` is neither
 *           `production` nor `stage`, and neither `VERCEL` nor
 *           `AWS_EXECUTION_ENV` is set.
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
export const E2E_LOCAL_TRUSTED_AUTH_ENABLED = "1";

/**
 * Vercel deploy environments where `local_trusted` must NEVER activate, even if
 * every other signal is (mis)set. `preview` is included: preview deployments are
 * internet-reachable and must stay Clerk-gated.
 */
const FORBIDDEN_VERCEL_ENVS = new Set(["production", "preview"]);

/**
 * ISS-12054: deploy signals that hold off Vercel too, so a deployment whose
 * `NODE_ENV` is not `production` (an ECS task that never set it, say) still
 * refuses the synthetic session. `NEXT_PUBLIC_APP_ENVIRONMENT` takes the values
 * `apps/app/env.ts` declares; `production` and `stage` are deployments.
 * `VERCEL` is set on every Vercel build and function, `AWS_EXECUTION_ENV` on
 * every ECS, Lambda and App Runner task; a local stack sets neither.
 */
const DEPLOYED_APP_ENVIRONMENTS = new Set(["production", "stage"]);
const DEPLOYED_PLATFORM_ENVS = ["VERCEL", "AWS_EXECUTION_ENV"] as const;

/**
 * DEFAULT synthetic identity — what the session reports unless the ISS-10335
 * overrides at the bottom of this file are supplied AND the guard has passed.
 * Obviously-synthetic; never a real user/org.
 */
export const LOCAL_TRUSTED_USER_ID = "user_e2e_local_trusted";
export const LOCAL_TRUSTED_ORG_ID = "org_e2e_local_trusted";
export const LOCAL_TRUSTED_ORG_SLUG = "closedloop-ai";
/**
 * ISS-11468: Clerk-shaped (`sess_` plus 27 base62 characters) because the API
 * lists it as a browser session and the revoke route rejects any id outside
 * that shape as malformed, which would answer 404 where the current session
 * gets its 409.
 */
export const LOCAL_TRUSTED_SESSION_ID = "sess_e2eLocalTrustedSession00000";
export const LOCAL_TRUSTED_ORG_ROLE = "org:admin";
/**
 * ISS-10335: the `@closedloop.ai` domain is load-bearing, not cosmetic. It is
 * what `isStaffEmail` (`packages/api/src/types/staff-email.ts`) matches, and
 * the staff-only affordances the e2e suite asserts — the dev-mode switch, the
 * parsing-bug checkbox — are hidden from this session without it. The local
 * part keeps the identity obviously synthetic and names no real employee.
 */
export const LOCAL_TRUSTED_USER_EMAIL = "e2e-local-trusted@closedloop.ai";

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
  const appEnvironment = env.NEXT_PUBLIC_APP_ENVIRONMENT;
  if (appEnvironment && DEPLOYED_APP_ENVIRONMENTS.has(appEnvironment)) {
    return false;
  }
  return !DEPLOYED_PLATFORM_ENVS.some((key) => Boolean(env[key]));
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
        "with E2E_LOCAL_TRUSTED_AUTH=1, VERCEL_ENV not production/preview, " +
        "NEXT_PUBLIC_APP_ENVIRONMENT not production/stage, and neither VERCEL " +
        "nor AWS_EXECUTION_ENV set. " +
        "Unset AUTH_MODE (defaults to clerk) for real deployments."
    );
  }
  return true;
}

/**
 * ISS-10335 identity overrides. A harness that wants the synthetic session to
 * BE a row it seeded — the Clerk-free e2e lane binds it to the seeded sandbox
 * org so data specs keep their fixtures — supplies these; everything else keeps
 * the fixed defaults above.
 *
 * Deliberately separate env vars rather than a widened `AUTH_MODE`: they carry
 * no privilege of their own. {@link resolveLocalTrustedIdentity} reads them only
 * once {@link isLocalTrustedAuthActive} has already said yes, so setting one on
 * a Clerk deployment changes nothing and the guard above is untouched.
 */
export const E2E_LOCAL_TRUSTED_USER_ID_ENV = "E2E_LOCAL_TRUSTED_USER_ID";
export const E2E_LOCAL_TRUSTED_ORG_ID_ENV = "E2E_LOCAL_TRUSTED_ORG_ID";
export const E2E_LOCAL_TRUSTED_ORG_SLUG_ENV = "E2E_LOCAL_TRUSTED_ORG_SLUG";
/**
 * ISS-12135: display overrides, under the same rule as the ids above. `pnpm
 * vibe up` sets them to the seeded org and signed-in person
 * (`.claude/skills/control/scripts/vibe/up.ts`) so its stack shows Acme Co and
 * the seeded signed-in person; every other lane leaves them unset and keeps
 * the defaults.
 */
export const E2E_LOCAL_TRUSTED_ORG_NAME_ENV = "E2E_LOCAL_TRUSTED_ORG_NAME";
export const E2E_LOCAL_TRUSTED_USER_EMAIL_ENV = "E2E_LOCAL_TRUSTED_USER_EMAIL";
export const E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV =
  "E2E_LOCAL_TRUSTED_USER_FIRST_NAME";
export const E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV =
  "E2E_LOCAL_TRUSTED_USER_LAST_NAME";

/**
 * The user/org the synthetic session reports. The display fields are present
 * only when overridden, so each projection keeps its own default otherwise
 * (read the user's through {@link resolveLocalTrustedUserProfile}).
 */
export type LocalTrustedIdentity = {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly userId: string;
  readonly orgName?: string;
  readonly userEmail?: string;
  readonly userFirstName?: string;
  readonly userLastName?: string;
};

const LOCAL_TRUSTED_DEFAULT_IDENTITY: LocalTrustedIdentity = {
  orgId: LOCAL_TRUSTED_ORG_ID,
  orgSlug: LOCAL_TRUSTED_ORG_SLUG,
  userId: LOCAL_TRUSTED_USER_ID,
};

/**
 * Resolve the identity the synthetic session reports.
 *
 * Returns the fixed defaults unless `local_trusted` is ACTIVE, so an override
 * left in an environment that resolves to Clerk is inert rather than
 * half-applied. When the mode is configured but forbidden here, this throws for
 * the same reason {@link isLocalTrustedAuthActive} does — it is the same call.
 *
 * Blank and whitespace-only values are treated as unset, matching the
 * `emptyStringAsUndefined` semantics every `keys.ts` in this repo declares: a
 * compose file forwarding an unprovisioned `${SEED_SANDBOX_CLERK_ORG_ID:-}` must
 * take the default, not bind the session to the empty string.
 */
export function resolveLocalTrustedIdentity(
  env: NodeJS.ProcessEnv = process.env
): LocalTrustedIdentity {
  if (!isLocalTrustedAuthActive(env)) {
    return LOCAL_TRUSTED_DEFAULT_IDENTITY;
  }

  return {
    orgId: readIdentityOverride(
      env,
      E2E_LOCAL_TRUSTED_ORG_ID_ENV,
      LOCAL_TRUSTED_ORG_ID
    ),
    orgSlug: readIdentityOverride(
      env,
      E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
      LOCAL_TRUSTED_ORG_SLUG
    ),
    userId: readIdentityOverride(
      env,
      E2E_LOCAL_TRUSTED_USER_ID_ENV,
      LOCAL_TRUSTED_USER_ID
    ),
    ...readDisplayOverrides(env),
  };
}

function readIdentityOverride(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string
): string {
  return env[key]?.trim() || fallback;
}

/** Only the display overrides that are set, so an unset one stays absent. */
function readDisplayOverrides(
  env: NodeJS.ProcessEnv
): Pick<
  LocalTrustedIdentity,
  "orgName" | "userEmail" | "userFirstName" | "userLastName"
> {
  const orgName = env[E2E_LOCAL_TRUSTED_ORG_NAME_ENV]?.trim();
  const userEmail = env[E2E_LOCAL_TRUSTED_USER_EMAIL_ENV]?.trim();
  const userFirstName = env[E2E_LOCAL_TRUSTED_USER_FIRST_NAME_ENV]?.trim();
  const userLastName = env[E2E_LOCAL_TRUSTED_USER_LAST_NAME_ENV]?.trim();
  return {
    ...(orgName && { orgName }),
    ...(userEmail && { userEmail }),
    ...(userFirstName && { userFirstName }),
    ...(userLastName && { userLastName }),
  };
}

/**
 * The display fields the synthetic user reports. Named here, beside the email
 * and the ids, because BOTH projections of that user read them: the server's
 * `currentUser()` builder (`local-trusted-session.ts`, which is `server-only`
 * and so cannot be the shared owner) and the browser's `useUser()`
 * (`local-trusted-client.tsx`). Two spellings of "E2E Local Trusted" is the
 * SSOT-drift-by-copy the repo keeps paying for.
 */
export const LOCAL_TRUSTED_USER_FIRST_NAME = "E2E";
export const LOCAL_TRUSTED_USER_LAST_NAME = "Local Trusted";
export const LOCAL_TRUSTED_USER_FULL_NAME = `${LOCAL_TRUSTED_USER_FIRST_NAME} ${LOCAL_TRUSTED_USER_LAST_NAME}`;
export const LOCAL_TRUSTED_USERNAME = "e2e-local-trusted";
/** Clerk keys the primary address by id, so both projections need the same one. */
export const LOCAL_TRUSTED_EMAIL_ADDRESS_ID = "idn_e2e_local_trusted";

/**
 * ISS-11468: what `apps/api`'s Clerk boundary (`lib/auth/clerk-service.ts`)
 * answers for the synthetic identity, beside the identity it describes. There is
 * no Clerk instance under `local_trusted`, so every read the API makes of Clerk
 * is answered from these rather than sent to a provider that has never heard of
 * `user_e2e_local_trusted`.
 */
export const LOCAL_TRUSTED_ORG_NAME = "E2E Local Trusted";
/**
 * The OAuth providers linked to the synthetic user: none. It is an email
 * account (it carries {@link LOCAL_TRUSTED_EMAIL_ADDRESS_ID} and no external
 * account), which is also what the session projections above report.
 */
export const LOCAL_TRUSTED_EXTERNAL_ACCOUNT_PROVIDERS: readonly string[] = [];

/** The synthetic user's display fields, as every projection of that user shows them. */
export type LocalTrustedUserProfile = {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
};

/**
 * ISS-12135: the synthetic user's display fields, from the identity's
 * overrides where set and the fixed defaults above otherwise. The server's
 * `currentUser()`, the browser's `useUser()`, the api's Clerk answers and the
 * web workspace menu all read the user through here, so they cannot disagree.
 */
export function resolveLocalTrustedUserProfile(
  identity: LocalTrustedIdentity
): LocalTrustedUserProfile {
  const firstName = identity.userFirstName ?? LOCAL_TRUSTED_USER_FIRST_NAME;
  const lastName = identity.userLastName ?? LOCAL_TRUSTED_USER_LAST_NAME;
  return {
    email: identity.userEmail ?? LOCAL_TRUSTED_USER_EMAIL,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
  };
}

/**
 * ISS-12135: whether the stack names its person (the `pnpm vibe up` stack),
 * so the synthetic session should read as that person's live browser session
 * rather than the fixed fixture every other lane pins.
 */
export function hasLocalTrustedDisplayOverrides(
  identity: LocalTrustedIdentity
): boolean {
  return (
    identity.orgName !== undefined ||
    identity.userEmail !== undefined ||
    identity.userFirstName !== undefined ||
    identity.userLastName !== undefined
  );
}
