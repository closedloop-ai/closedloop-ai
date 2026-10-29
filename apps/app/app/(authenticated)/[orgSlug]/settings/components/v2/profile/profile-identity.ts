import {
  getInitials,
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import type { useUser } from "@repo/auth/client";

/**
 * @file profile-identity.ts
 * @description Projects a Clerk `UserResource` onto the values the Settings
 * Profile panel renders (ISS-8364). A thin ADAPTER on purpose: the naming rules
 * stay in `@repo/app/shared/lib/user-utils`, which is Clerk-free and already
 * the SSOT for "First Last / email" and initials. Nothing here invents a
 * derivation — a second display-name rule is exactly the drift this delegation
 * prevents.
 *
 * The prototype's "Product builder" subtitle has NO Clerk source, so this emits
 * none. Rendering a plausible-looking role we cannot measure would be the
 * fabricated-value defect AGENTS.md forbids, not a nicety.
 */
/**
 * Clerk's resource types are not re-exported by `@clerk/nextjs`, and
 * `@repo/auth/client` barrels that package. Deriving them from the hooks the
 * panel already calls keeps one source for the shape and avoids adding a
 * `@clerk/types` dependency this app does not otherwise declare.
 */
export type ClerkUser = NonNullable<ReturnType<typeof useUser>["user"]>;
export type ClerkExternalAccount = ClerkUser["externalAccounts"][number];

export type ProfileIdentity = {
  displayName: string;
  initials: string;
  imageUrl: string | null;
  /** Null when Clerk has no primary email — the row says so rather than blanking. */
  primaryEmail: string | null;
  passwordEnabled: boolean;
  /** Clerk instance setting; false hides the delete card entirely. */
  deleteSelfEnabled: boolean;
};

export function profileIdentityFromUser(user: ClerkUser): ProfileIdentity {
  const primaryEmail = user.primaryEmailAddress?.emailAddress ?? null;
  const displayName = getUserDisplayName({
    firstName: user.firstName,
    lastName: user.lastName,
    email: primaryEmail ?? undefined,
  });

  return {
    displayName,
    initials:
      getUserInitials(user.firstName, user.lastName) ||
      getInitials(displayName),
    imageUrl: user.imageUrl || null,
    primaryEmail,
    passwordEnabled: user.passwordEnabled,
    deleteSelfEnabled: user.deleteSelfEnabled,
  };
}
