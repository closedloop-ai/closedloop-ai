import "server-only";
import type {
  auth as clerkAuth,
  currentUser as clerkCurrentUser,
} from "@clerk/nextjs/server";
import { LOCAL_TRUSTED_CLIENT_TOKEN } from "@repo/api/src/types/local-trusted-auth";
import { redirect } from "next/navigation";
import {
  LOCAL_TRUSTED_EMAIL_ADDRESS_ID,
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_SESSION_ID,
  LOCAL_TRUSTED_USERNAME,
  resolveLocalTrustedIdentity,
  resolveLocalTrustedUserProfile,
} from "./auth-mode";
import {
  buildLocalTrustedSessionClaims,
  hasLocalTrustedRole,
  SYNTHETIC_ISSUED_AT_SECONDS,
} from "./local-trusted-claims";

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
/** The signed-in member, which is what the synthetic session always is. */
type SignedInClerkAuthObject = Extract<
  ClerkAuthObject,
  { isAuthenticated: true }
>;
type ClerkUser = NonNullable<Awaited<ReturnType<typeof clerkCurrentUser>>>;

/**
 * Build the synthetic signed-in `auth()` object: the user and active org
 * {@link resolveLocalTrustedIdentity} reports, with a `getToken`/`has`/redirect
 * surface the authenticated layout reads. `has` reports the synthetic org-admin
 * role.
 *
 * `getToken` hands back {@link LOCAL_TRUSTED_CLIENT_TOKEN} — the same inert
 * marker `apps/app`'s client adapter sends and the `local_trusted` api accepts.
 * A null here is not "no token", it is a 404: a server component that reads the
 * token before calling the api (`documents/[slug]/page.tsx`) takes its
 * not-found branch without ever issuing the request (ISS-10335).
 */
export function buildLocalTrustedAuth(): SignedInClerkAuthObject {
  const identity = resolveLocalTrustedIdentity();
  const sessionClaims = buildLocalTrustedSessionClaims(identity);

  const auth: SignedInClerkAuthObject = {
    actor: undefined,
    debug: () => ({ localTrusted: true }),
    factorVerificationAge: null,
    getToken: () => Promise.resolve(LOCAL_TRUSTED_CLIENT_TOKEN),
    has: hasLocalTrustedRole,
    isAuthenticated: true,
    orgId: identity.orgId,
    orgPermissions: [],
    orgRole: LOCAL_TRUSTED_ORG_ROLE,
    orgSlug: identity.orgSlug,
    redirectToSignIn: () => redirect("/sign-in"),
    redirectToSignUp: () => redirect("/sign-up"),
    sessionClaims,
    sessionId: LOCAL_TRUSTED_SESSION_ID,
    sessionStatus: "active",
    tokenType: "session_token",
    userId: identity.userId,
  };

  return auth;
}

/**
 * Build the synthetic `currentUser()` result. Consumers on the render path only
 * check truthiness (`if (!user) redirect(...)`), so this returns a minimal
 * synthetic user carrying the resolved id.
 *
 * Clerk's `User` is a nominal class (getters + a private field), and the runtime
 * class is NOT part of Clerk's public value exports (only `verifyToken` /
 * `createClerkClient` are), so a real instance cannot be constructed offline via
 * any public API, so a single `as` assertion is unavoidable here: the synthetic
 * user is built as a `User`-shaped literal (public fields the layout could read)
 * and asserted to the derived `User` type. ISS-10335 gave the BROWSER the same
 * user, and `local-trusted-client.tsx` is under the identical constraint for the
 * identical reason — the two projections are separate only because this module
 * is `server-only`, and they agree by reading one profile resolver. It is a fixed,
 * obviously-synthetic value used ONLY behind the non-production `local_trusted`
 * guard, and the render path reads only its truthiness. (Not `as unknown as` —
 * the literal overlaps the target enough for a single assertion, keeping the
 * double-cast ban satisfied.)
 */
export function buildLocalTrustedUser(): ClerkUser {
  const identity = resolveLocalTrustedIdentity();
  const profile = resolveLocalTrustedUserProfile(identity);
  const synthetic = {
    banned: false,
    createOrganizationEnabled: false,
    createOrganizationsLimit: 0,
    createdAt: SYNTHETIC_ISSUED_AT_SECONDS,
    deleteSelfEnabled: false,
    emailAddresses: [
      {
        emailAddress: profile.email,
        id: LOCAL_TRUSTED_EMAIL_ADDRESS_ID,
      },
    ],
    externalId: null,
    firstName: profile.firstName,
    fullName: profile.fullName,
    hasImage: false,
    id: identity.userId,
    imageUrl: "",
    lastName: profile.lastName,
    locked: false,
    primaryEmailAddressId: LOCAL_TRUSTED_EMAIL_ADDRESS_ID,
    primaryPhoneNumberId: null,
    primaryWeb3WalletId: null,
    privateMetadata: {},
    publicMetadata: {},
    unsafeMetadata: {},
    updatedAt: SYNTHETIC_ISSUED_AT_SECONDS,
    username: LOCAL_TRUSTED_USERNAME,
  };

  // Justified single cast — see the doc comment above: Clerk's runtime `User`
  // class is not publicly constructable, and the render path never reads these
  // fields off the server return (truthiness only).
  return synthetic as ClerkUser;
}
