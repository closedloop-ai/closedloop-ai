import "server-only";
import type {
  auth as clerkAuth,
  currentUser as clerkCurrentUser,
} from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_ORG_SLUG,
  LOCAL_TRUSTED_SESSION_ID,
  LOCAL_TRUSTED_USER_EMAIL,
  LOCAL_TRUSTED_USER_ID,
} from "./auth-mode";

/**
 * FEA-4334: builders for the synthetic `local_trusted` session. These are only
 * ever returned once {@link isLocalTrustedAuthActive} has confirmed the hard
 * non-production guard passed (see `auth-mode.ts`); nothing here re-checks the
 * environment, so callers MUST gate on that first.
 *
 * The shapes are derived from Clerk's own return types (`Awaited<ReturnType<…>>`)
 * so a Clerk upgrade that changes the auth/user contract surfaces here as a
 * type error rather than drifting silently.
 */
type ClerkAuthObject = Awaited<ReturnType<typeof clerkAuth>>;
type ClerkUser = NonNullable<Awaited<ReturnType<typeof clerkCurrentUser>>>;

// A far-future expiry so the synthetic claims never read as "expired"; the
// values are inert (no signature is ever verified for this session).
const SYNTHETIC_ISSUED_AT_SECONDS = 0;
const SYNTHETIC_EXPIRY_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

/**
 * Build the synthetic signed-in `auth()` object: a fixed user in a fixed active
 * org, with a `getToken`/`has`/redirect surface the authenticated layout reads.
 * `getToken` returns null (no downstream API call is expected in the visual
 * container) and `has` reports the synthetic org-admin role.
 */
export function buildLocalTrustedAuth(): ClerkAuthObject {
  const sessionClaims = {
    __raw: "",
    azp: undefined,
    exp: SYNTHETIC_EXPIRY_SECONDS,
    iat: SYNTHETIC_ISSUED_AT_SECONDS,
    iss: "https://local-trusted.e2e.test",
    nbf: SYNTHETIC_ISSUED_AT_SECONDS,
    org_id: LOCAL_TRUSTED_ORG_ID,
    org_permissions: [],
    org_role: LOCAL_TRUSTED_ORG_ROLE,
    org_slug: LOCAL_TRUSTED_ORG_SLUG,
    sid: LOCAL_TRUSTED_SESSION_ID,
    sub: LOCAL_TRUSTED_USER_ID,
  } satisfies ClerkAuthObject["sessionClaims"];

  const auth: ClerkAuthObject = {
    actor: undefined,
    debug: () => ({ localTrusted: true }),
    factorVerificationAge: null,
    getToken: () => Promise.resolve(null),
    has: (params) => params.role === LOCAL_TRUSTED_ORG_ROLE,
    isAuthenticated: true,
    orgId: LOCAL_TRUSTED_ORG_ID,
    orgPermissions: [],
    orgRole: LOCAL_TRUSTED_ORG_ROLE,
    orgSlug: LOCAL_TRUSTED_ORG_SLUG,
    redirectToSignIn: () => redirect("/sign-in"),
    redirectToSignUp: () => redirect("/sign-up"),
    sessionClaims,
    sessionId: LOCAL_TRUSTED_SESSION_ID,
    sessionStatus: "active",
    tokenType: "session_token",
    userId: LOCAL_TRUSTED_USER_ID,
  };

  return auth;
}

/**
 * Build the synthetic `currentUser()` result. Consumers on the render path only
 * check truthiness (`if (!user) redirect(...)`), so this returns a minimal but
 * fixed synthetic user.
 *
 * Clerk's `User` is a nominal class (getters + a private field), and the runtime
 * class is NOT part of Clerk's public value exports (only `verifyToken` /
 * `createClerkClient` are), so a real instance cannot be constructed offline via
 * any public API. This is the one place a single `as` assertion is unavoidable:
 * the synthetic user is built as a `User`-shaped literal (public fields the
 * layout could read) and asserted to the derived `User` type. It is a fixed,
 * obviously-synthetic value used ONLY behind the non-production `local_trusted`
 * guard, and the render path reads only its truthiness. (Not `as unknown as` —
 * the literal overlaps the target enough for a single assertion, keeping the
 * double-cast ban satisfied.)
 */
export function buildLocalTrustedUser(): ClerkUser {
  const synthetic = {
    banned: false,
    createOrganizationEnabled: false,
    createOrganizationsLimit: 0,
    createdAt: SYNTHETIC_ISSUED_AT_SECONDS,
    deleteSelfEnabled: false,
    emailAddresses: [
      {
        emailAddress: LOCAL_TRUSTED_USER_EMAIL,
        id: "idn_e2e_local_trusted",
      },
    ],
    externalId: null,
    firstName: "E2E",
    fullName: "E2E Local Trusted",
    hasImage: false,
    id: LOCAL_TRUSTED_USER_ID,
    imageUrl: "",
    lastName: "Local Trusted",
    locked: false,
    primaryEmailAddressId: "idn_e2e_local_trusted",
    primaryPhoneNumberId: null,
    primaryWeb3WalletId: null,
    privateMetadata: {},
    publicMetadata: {},
    unsafeMetadata: {},
    updatedAt: SYNTHETIC_ISSUED_AT_SECONDS,
    username: "e2e-local-trusted",
  };

  // Justified single cast — see the doc comment above: Clerk's runtime `User`
  // class is not publicly constructable, and the render path never reads these
  // fields off the server return (truthiness only).
  return synthetic as ClerkUser;
}
