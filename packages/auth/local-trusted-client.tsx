"use client";

import type { useUser as useClerkUser } from "@clerk/nextjs";
import { createContext, type ReactNode, useContext } from "react";
import {
  LOCAL_TRUSTED_EMAIL_ADDRESS_ID,
  LOCAL_TRUSTED_USERNAME,
  type LocalTrustedIdentity,
  resolveLocalTrustedUserProfile,
} from "./auth-mode";

/**
 * The browser half of the `AUTH_MODE=local_trusted` synthetic session
 * (ISS-10335).
 *
 * `local_trusted` decides the identity SERVER-side, before the document is
 * sent. Nothing signs in, so the browser has no Clerk session at all
 * (`__client_uat=0`), and Clerk's own `useUser()` settles on `user: null`
 * forever. Every client guard keyed on `user?.id` therefore read the viewer as
 * signed out on the lane the synthetic session exists to serve.
 *
 * So the same server-resolved identity the layout already hands the auth
 * adapter is carried into the client tree here, and the `@repo/auth/client`
 * hooks (`local-trusted-hooks.ts`) answer from it. Since ISS-12054 the root
 * layout mounts this provider INSTEAD of `ClerkProvider`, so the browser never
 * loads Clerk under `local_trusted`. It cannot come from the environment instead: `E2E_LOCAL_TRUSTED_*`
 * is not `NEXT_PUBLIC_`, and the lane shares `apps/app`'s build anchor
 * (`e2e/compose.yml`), so a build arg would flip the live-Clerk lane too.
 *
 * This module is the ONE owner of that context. It lives in `packages/auth`
 * rather than `apps/app` because `@repo/auth/client` — which `apps/app`,
 * `packages/analytics` and the desktop renderer all import — has to read it,
 * and a package cannot reach into an app.
 */
const LocalTrustedIdentityContext = createContext<LocalTrustedIdentity | null>(
  null
);

export function LocalTrustedIdentityProvider({
  children,
  identity,
}: {
  children: ReactNode;
  identity: LocalTrustedIdentity | null;
}) {
  return (
    <LocalTrustedIdentityContext.Provider value={identity}>
      {children}
    </LocalTrustedIdentityContext.Provider>
  );
}

/**
 * The synthetic identity when the synthetic session is active, else `null`.
 *
 * Deliberately usable without a provider — it defaults to `null`, which is the
 * real-deployment answer — so a component tree mounted in a test, a story, or
 * the desktop renderer behaves as a Clerk surface rather than throwing.
 */
export function useLocalTrustedIdentity(): LocalTrustedIdentity | null {
  return useContext(LocalTrustedIdentityContext);
}

/** Clerk's own `useUser()` result — the shape this module must answer in. */
type ClerkUserHookResult = ReturnType<typeof useClerkUser>;
type ClerkUser = NonNullable<ClerkUserHookResult["user"]>;
type ClerkEmailAddress = ClerkUser["emailAddresses"][number];

/**
 * The synthetic user `useUser()` answers with (`local-trusted-hooks.ts`), as a
 * pure fold so it is testable without a DOM.
 *
 * `isLoaded` is true immediately on the synthetic path: the identity arrived
 * with the document, so there is no hydration window to report as unsettled.
 */
export function resolveLocalTrustedUser(
  clerkUser: ClerkUserHookResult,
  identity: LocalTrustedIdentity | null
): ClerkUserHookResult {
  if (!identity) {
    return clerkUser;
  }
  return {
    isLoaded: true,
    isSignedIn: true,
    user: localTrustedUser(identity),
  };
}

/**
 * The synthetic `UserResource`, carrying exactly the fields this repo's
 * `useUser()` consumers actually dereference — `id`, the primary/`emailAddresses`
 * pair, the name trio, `username`, `imageUrl`, `externalAccounts`, and the two
 * profile-panel flags. A field nobody reads is deliberately absent rather than
 * invented, and `imageUrl` is empty because there is no avatar: every consumer
 * spells `user.imageUrl || null`, so an empty string is the honest "none".
 *
 * The values agree with the server's `currentUser()` projection by construction:
 * both read `resolveLocalTrustedUserProfile` in `auth-mode.ts`.
 */
function localTrustedUser(identity: LocalTrustedIdentity): ClerkUser {
  const profile = resolveLocalTrustedUserProfile(identity);
  const emailAddress = asClerkEmailAddress({
    emailAddress: profile.email,
    id: LOCAL_TRUSTED_EMAIL_ADDRESS_ID,
  });

  return asClerkUser({
    deleteSelfEnabled: false,
    emailAddresses: [emailAddress],
    externalAccounts: [],
    firstName: profile.firstName,
    fullName: profile.fullName,
    hasImage: false,
    id: identity.userId,
    imageUrl: "",
    lastName: profile.lastName,
    passwordEnabled: false,
    primaryEmailAddress: emailAddress,
    primaryEmailAddressId: LOCAL_TRUSTED_EMAIL_ADDRESS_ID,
    publicMetadata: {},
    unsafeMetadata: {},
    username: LOCAL_TRUSTED_USERNAME,
  });
}

/**
 * Clerk's resources are nominal classes whose constructors are not public
 * exports, so a real instance cannot be built offline — the same constraint
 * `buildLocalTrustedUser` documents on the server side. A `Partial` parameter
 * keeps every key and value type checked (a typo still fails `tsc`) while
 * narrowing in ONE single assertion, never a double cast.
 */
function asClerkUser(fields: Partial<ClerkUser>): ClerkUser {
  return fields as ClerkUser;
}

function asClerkEmailAddress(
  fields: Partial<ClerkEmailAddress>
): ClerkEmailAddress {
  return fields as ClerkEmailAddress;
}
